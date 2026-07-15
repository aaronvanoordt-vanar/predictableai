/**
 * js/whatsapp-inbox.js — WhatsApp Inbox (Meta WhatsApp Business Cloud API)
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-contained view module. Renders into #wa-inbox-shell (inside
 * #page-wa-inbox). WATI-style 3-pane inbox:
 *
 *   [conversaciones] [hilo de chat + composer] [ficha del contacto]
 *
 * Backend: tablas whatsapp_* en Supabase (RLS por dueño), edge functions
 * whatsapp-send (todo lo saliente), whatsapp-webhook (todo lo entrante) y
 * whatsapp-followups (cron de seguimientos programados). El usuario conecta
 * SU PROPIO número de la Cloud API de Meta; las credenciales nunca tocan
 * este cliente (columnas access_token/app_secret no son legibles por RLS +
 * grants de columna).
 *
 * Public API:
 *   window.waInbox.show()                 // monta/refresca el inbox
 *   window.waInbox.refreshBadge()         // badge de no-leídos del sidebar
 *   window.waInbox.openForMember(id, txt) // abre conversación con un lead
 *
 * Convenciones: todo string dinámico pasa por window.escHtml, todo href por
 * window.safeUrl. Copy en español neutro LatAm. Sin datos de demo.
 */
(function () {
  'use strict';

  var FN_SEND = 'whatsapp-send';
  var BUCKET = 'whatsapp-media';
  var PAGE_SIZE = 50;

  // Límites de Meta por tipo de adjunto (bytes).
  var SIZE_LIMITS = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 100 * 1024 * 1024 };

  var REACT_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  var COMPOSER_EMOJIS = ['😀','😄','😅','😂','🙂','😉','😍','🤝','👍','👏','🙏','💪','🎉','🔥','✅','⭐','💡','📈','📅','☕','🚀','🤔','😮','❤️'];

  var state = {
    built: false,
    shell: null,
    uid: null,
    account: undefined,          // undefined = sin cargar · null = sin conectar
    conversations: [],
    convsLoading: false,
    convError: null,
    memberNames: {},             // member_id → {name,title,company}
    pendingFu: {},               // conversation_id → nº de seguimientos pendientes
    activeConvId: null,
    messages: [],
    msgsLoading: false,
    hasOlder: false,
    member: null,                // fila prospect_list_members de la conv activa
    memberLists: {},             // list_id → nombre
    followups: [],
    filter: 'all',
    search: '',
    replyTo: null,
    attach: null,                // {file, kind, url}
    rec: null,                   // {recorder, chunks, timer, t0, mime, stream}
    channel: null,
    sending: false,
    detailOpen: window.innerWidth > 1180,
  };

  // ── Helpers base ─────────────────────────────────────────────────────────
  function sb() {
    if (!window.supabaseClient) throw new Error('Supabase no está inicializado. Recarga la página.');
    return window.supabaseClient;
  }
  function esc(s) { return window.escHtml ? window.escHtml(s) : String(s == null ? '' : s); }
  function sUrl(u) { return window.safeUrl ? window.safeUrl(u) : '#'; }
  function toast(msg, type) {
    if (window.uiHelpers && window.uiHelpers.toast) window.uiHelpers.toast(msg, type || 'info');
    else console.log('[wa-inbox]', type, msg);
  }
  function errMsg(e) { return (e && e.message) || String(e || 'Error inesperado'); }

  function getUid() {
    if (state.uid) return Promise.resolve(state.uid);
    return sb().auth.getUser().then(function (r) {
      var u = r && r.data && r.data.user;
      if (!u) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
      state.uid = u.id;
      return u.id;
    });
  }

  function edge(action, payload) {
    return sb().auth.getSession().then(function (r) {
      var token = r && r.data && r.data.session && r.data.session.access_token;
      if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
      return fetch(window.SUPABASE_CONFIG.url + '/functions/v1/' + FN_SEND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: action, payload: payload || {} }),
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || !body || body.ok !== true) {
          throw new Error((body && body.error) || ('Error del backend (HTTP ' + res.status + ')'));
        }
        return body.data;
      });
    });
  }

  function mediaUrl(path) {
    if (!path) return '#';
    return window.SUPABASE_CONFIG.url + '/storage/v1/object/public/' + BUCKET + '/' +
      String(path).split('/').map(encodeURIComponent).join('/');
  }

  function digitsOf(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    return d;
  }

  // ── Formato de fechas ────────────────────────────────────────────────────
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function fmtDaySep(iso) {
    var d = new Date(iso), now = new Date();
    if (sameDay(d, now)) return 'Hoy';
    var y = new Date(now.getTime() - 86400000);
    if (sameDay(d, y)) return 'Ayer';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  }
  function fmtRel(iso) {
    if (!iso) return '';
    var d = new Date(iso), now = new Date();
    if (sameDay(d, now)) return fmtTime(iso);
    var y = new Date(now.getTime() - 86400000);
    if (sameDay(d, y)) return 'Ayer';
    return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
  }
  function fmtFull(iso) {
    try { return new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }

  // ── Identidad visual del contacto ────────────────────────────────────────
  var AVATAR_HUES = [212, 158, 262, 16, 190, 330, 96, 40];
  function avatarStyle(seed) {
    var n = 0; seed = String(seed || '');
    for (var i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0;
    var hue = AVATAR_HUES[n % AVATAR_HUES.length];
    return 'background:hsl(' + hue + ',42%,90%);color:hsl(' + hue + ',45%,32%)';
  }
  function initialsOf(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '#';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function convName(c) {
    if (c.member_id && state.memberNames[c.member_id] && state.memberNames[c.member_id].name) {
      return state.memberNames[c.member_id].name;
    }
    return c.profile_name || ('+' + c.wa_id);
  }

  // ── CSS (inyectado — evita crecer el monolito index.html) ────────────────
  function injectCss() {
    if (document.getElementById('wai-css')) return;
    var css = '' +
'#wa-inbox-shell{display:flex;flex-direction:column;height:100vh;min-width:0;background:var(--bg)}' +
'.wai-top{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--hair);background:var(--surface);flex-shrink:0}' +
'.wai-top-title{font-size:15px;font-weight:650;letter-spacing:-0.01em;color:var(--ink)}' +
'.wai-top-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-3)}' +
'.wai-dot{width:7px;height:7px;border-radius:50%;background:var(--green);flex-shrink:0}' +
'.wai-dot.err{background:var(--red)}' +
'.wai-body{flex:1;display:flex;min-height:0}' +
'.wai-left{width:320px;min-width:260px;border-right:1px solid var(--hair);display:flex;flex-direction:column;background:var(--surface)}' +
'.wai-left-head{padding:12px 14px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--hair-2)}' +
'.wai-search{width:100%;padding:8px 12px;border:1px solid var(--hair-3);border-radius:var(--r-md);background:var(--surface2);color:var(--ink);font-size:13px;font-family:var(--font-body);outline:none}' +
'.wai-search:focus{border-color:var(--accent);background:var(--surface)}' +
'.wai-filters{display:flex;gap:6px}' +
'.wai-chipbtn{padding:4px 11px;font-size:11.5px;font-weight:550;border:1px solid var(--hair-3);border-radius:999px;background:transparent;color:var(--ink-3);cursor:pointer;font-family:var(--font-body)}' +
'.wai-chipbtn.on{background:var(--accent-soft);border-color:var(--hair-3);color:var(--accent-ink)}' +
'.wai-convlist{flex:1;overflow-y:auto;padding:6px}' +
'.wai-conv{display:flex;gap:10px;align-items:center;padding:10px;border-radius:var(--r-md);cursor:pointer;min-width:0}' +
'.wai-conv:hover{background:var(--surface2)}' +
'.wai-conv.on{background:var(--accent-soft)}' +
'.wai-avatar{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:650;flex-shrink:0}' +
'.wai-conv-main{flex:1;min-width:0}' +
'.wai-conv-top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}' +
'.wai-conv-name{font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
'.wai-conv-time{font-size:10.5px;color:var(--ink-4);flex-shrink:0}' +
'.wai-conv-bottom{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:2px}' +
'.wai-conv-preview{font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
'.wai-unread{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--green);color:#fff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
'.wai-fu-flag{font-size:11px;flex-shrink:0}' +
'.wai-chat{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--wa-bg)}' +
'.wai-chat-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--hair);background:var(--surface);flex-shrink:0}' +
'.wai-chat-head-name{font-size:13.5px;font-weight:650;color:var(--ink)}' +
'.wai-chat-head-sub{font-size:11.5px;color:var(--ink-3)}' +
'.wai-thread{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:4px}' +
'.wai-daysep{align-self:center;font-size:10.5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--ink-3);background:var(--surface);border:1px solid var(--hair);border-radius:999px;padding:3px 12px;margin:10px 0 6px}' +
'.wai-msg{max-width:min(72%,520px);position:relative;margin-bottom:4px}' +
'.wai-msg.in{align-self:flex-start}' +
'.wai-msg.out{align-self:flex-end}' +
'.wai-bubble{border-radius:12px;padding:7px 10px 5px;font-size:13.5px;line-height:1.5;color:var(--ink);box-shadow:var(--shadow-1);word-break:break-word}' +
'.wai-msg.in .wai-bubble{background:var(--wa-bubble);border-top-left-radius:4px}' +
'.wai-msg.out .wai-bubble{background:var(--accent-soft);border:1px solid var(--accent-soft-2);border-top-right-radius:4px}' +
'.wai-msg-body{white-space:pre-wrap}' +
'.wai-msg-meta{display:flex;justify-content:flex-end;align-items:center;gap:4px;font-size:10px;color:var(--ink-4);margin-top:2px;user-select:none}' +
'.wai-ticks{letter-spacing:-2px}' +
'.wai-ticks.read{color:var(--accent)}' +
'.wai-ticks.failed{color:var(--red);letter-spacing:0}' +
'.wai-quote{border-left:3px solid var(--accent);background:var(--surface2);border-radius:6px;padding:4px 8px;font-size:12px;color:var(--ink-3);margin-bottom:5px;overflow:hidden;max-height:52px}' +
'.wai-quote b{display:block;font-size:11px;color:var(--accent-ink)}' +
'.wai-media-img{max-width:100%;max-height:320px;border-radius:8px;display:block;cursor:zoom-in;margin-bottom:4px}' +
'.wai-media-video{max-width:100%;max-height:320px;border-radius:8px;display:block;margin-bottom:4px}' +
'.wai-media-audio{width:240px;max-width:100%;display:block;margin:4px 0}' +
'.wai-doc{display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--hair);border-radius:8px;padding:8px 10px;font-size:12.5px;color:var(--accent-ink);text-decoration:none;margin-bottom:4px;word-break:break-all}' +
'.wai-reactions{display:flex;gap:4px;margin-top:3px}' +
'.wai-reaction-chip{background:var(--surface);border:1px solid var(--hair);border-radius:999px;padding:1px 7px;font-size:12px;box-shadow:var(--shadow-1)}' +
'.wai-msg-actions{position:absolute;top:-12px;display:none;gap:2px;background:var(--surface);border:1px solid var(--hair);border-radius:999px;padding:2px;box-shadow:var(--shadow-2);z-index:5}' +
'.wai-msg.in .wai-msg-actions{right:-6px}' +
'.wai-msg.out .wai-msg-actions{left:-6px}' +
'.wai-msg:hover .wai-msg-actions{display:flex}' +
'.wai-mact{border:none;background:transparent;cursor:pointer;font-size:13px;padding:3px 6px;border-radius:999px;color:var(--ink-3);line-height:1}' +
'.wai-mact:hover{background:var(--surface2);color:var(--ink)}' +
'.wai-reactpop{position:absolute;top:-46px;background:var(--surface);border:1px solid var(--hair);border-radius:999px;padding:5px 8px;display:flex;gap:4px;box-shadow:var(--shadow-3);z-index:9}' +
'.wai-msg.in .wai-reactpop{left:0}.wai-msg.out .wai-reactpop{right:0}' +
'.wai-reactpop button{border:none;background:transparent;font-size:17px;cursor:pointer;padding:2px 4px;border-radius:8px}' +
'.wai-reactpop button:hover{background:var(--surface2)}' +
'.wai-failed-note{font-size:11px;color:var(--red);margin-top:3px}' +
'.wai-window-note{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;color:var(--amber);background:var(--amber-soft);border:1px solid rgba(184,117,20,.3);border-radius:var(--r-md);padding:8px 12px;margin:0 16px 8px}' +
'.wai-composer{background:var(--surface);border-top:1px solid var(--hair);padding:10px 14px;flex-shrink:0}' +
'.wai-replybar{display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--surface2);border-left:3px solid var(--accent);border-radius:6px;padding:6px 10px;font-size:12px;color:var(--ink-3);margin-bottom:8px}' +
'.wai-attachbar{display:flex;align-items:center;gap:10px;background:var(--surface2);border:1px solid var(--hair);border-radius:8px;padding:6px 10px;font-size:12.5px;color:var(--ink-2);margin-bottom:8px}' +
'.wai-comp-row{display:flex;align-items:flex-end;gap:8px}' +
'.wai-iconbtn{width:34px;height:34px;border-radius:50%;border:none;background:transparent;color:var(--ink-3);font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
'.wai-iconbtn:hover{background:var(--surface2);color:var(--ink)}' +
'.wai-iconbtn.rec{color:#fff;background:var(--red)}' +
'.wai-input{flex:1;resize:none;border:1px solid var(--hair-3);border-radius:18px;background:var(--surface2);padding:8px 14px;font-size:13.5px;font-family:var(--font-body);color:var(--ink);line-height:1.45;max-height:120px;outline:none;min-height:36px}' +
'.wai-input:focus{border-color:var(--accent);background:var(--surface)}' +
'.wai-sendbtn{width:38px;height:38px;border-radius:50%;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
'.wai-sendbtn:disabled{opacity:.5;cursor:default}' +
'.wai-emojipop{position:absolute;bottom:52px;left:10px;background:var(--surface);border:1px solid var(--hair);border-radius:12px;box-shadow:var(--shadow-3);padding:10px;display:grid;grid-template-columns:repeat(8,1fr);gap:2px;z-index:20}' +
'.wai-emojipop button{border:none;background:transparent;font-size:18px;cursor:pointer;border-radius:6px;padding:3px}' +
'.wai-emojipop button:hover{background:var(--surface2)}' +
'.wai-recbar{display:flex;align-items:center;gap:10px;flex:1;font-size:13px;color:var(--red);font-variant-numeric:tabular-nums}' +
'.wai-recdot{width:9px;height:9px;border-radius:50%;background:var(--red);animation:waiPulse 1.1s infinite}' +
'@keyframes waiPulse{0%,100%{opacity:1}50%{opacity:.25}}' +
'.wai-detail{width:312px;min-width:270px;border-left:1px solid var(--hair);background:var(--surface);overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:16px}' +
'.wai-d-sec{display:flex;flex-direction:column;gap:8px}' +
'.wai-d-title{font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--ink-4)}' +
'.wai-d-row{display:flex;flex-direction:column;gap:1px;font-size:12.5px}' +
'.wai-d-lbl{font-size:10.5px;color:var(--ink-4)}' +
'.wai-d-val{color:var(--ink-2);word-break:break-word}' +
'.wai-d-val a{color:var(--accent-ink);text-decoration:none}' +
'.wai-fu-item{display:flex;flex-direction:column;gap:3px;border:1px solid var(--hair);border-radius:var(--r-md);padding:8px 10px;font-size:12px}' +
'.wai-fu-when{font-size:11px;font-weight:600;color:var(--accent-ink)}' +
'.wai-fu-when.failed{color:var(--red)}.wai-fu-when.sent{color:var(--green)}' +
'.wai-fu-body{color:var(--ink-3);white-space:pre-wrap;word-break:break-word}' +
'.wai-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--ink-3);text-align:center;padding:30px}' +
'.wai-modal-ovl{position:fixed;inset:0;background:rgba(10,10,15,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}' +
'.wai-modal{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg);box-shadow:var(--shadow-3);width:100%;max-width:520px;max-height:88vh;overflow-y:auto;padding:20px 22px;display:flex;flex-direction:column;gap:12px}' +
'.wai-modal h3{margin:0;font-size:15px;font-weight:650;color:var(--ink)}' +
'.wai-modal .wai-m-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}' +
'.wai-field{display:flex;flex-direction:column;gap:4px}' +
'.wai-field label{font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;color:var(--ink-4)}' +
'.wai-field input,.wai-field textarea,.wai-field select{width:100%;padding:8px 11px;border:1px solid var(--hair-3);border-radius:var(--r-md);background:var(--surface2);color:var(--ink);font-size:13px;font-family:var(--font-body);outline:none;box-sizing:border-box}' +
'.wai-field input:focus,.wai-field textarea:focus{border-color:var(--accent);background:var(--surface)}' +
'.wai-hint{font-size:11.5px;color:var(--ink-3);line-height:1.55}' +
'.wai-code{display:flex;gap:6px;align-items:center;background:var(--surface2);border:1px solid var(--hair);border-radius:var(--r-md);padding:7px 10px;font-family:var(--font-mono);font-size:11.5px;color:var(--ink-2);word-break:break-all}' +
'.wai-steps{display:flex;flex-direction:column;gap:10px;counter-reset:wai}' +
'.wai-step{display:flex;gap:10px;font-size:12.5px;color:var(--ink-2);line-height:1.55}' +
'.wai-step::before{counter-increment:wai;content:counter(wai);width:20px;height:20px;border-radius:50%;background:var(--accent-soft);color:var(--accent-ink);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}' +
'.wai-connect-wrap{flex:1;overflow-y:auto;display:flex;justify-content:center;padding:34px 20px}' +
'.wai-connect{width:100%;max-width:640px;display:flex;flex-direction:column;gap:16px}' +
'.wai-pick-item{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:var(--r-md);cursor:pointer}' +
'.wai-pick-item:hover{background:var(--surface2)}' +
'@media (max-width:1180px){.wai-detail{display:none}.wai-detail.force{display:flex;position:absolute;right:0;top:0;bottom:0;z-index:30;box-shadow:var(--shadow-3)}}' +
'@media (max-width:860px){.wai-left{width:250px;min-width:220px}}';
    var tag = document.createElement('style');
    tag.id = 'wai-css';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── Modal genérico ───────────────────────────────────────────────────────
  function openModal(title, bodyNode, actions) {
    var ovl = document.createElement('div');
    ovl.className = 'wai-modal-ovl';
    var card = document.createElement('div');
    card.className = 'wai-modal';
    var h3 = document.createElement('h3');
    h3.textContent = title;
    card.appendChild(h3);
    card.appendChild(bodyNode);
    var bar = document.createElement('div');
    bar.className = 'wai-m-actions';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.className = a.className || 'btn btn-ghost btn-sm';
      b.textContent = a.label;
      b.addEventListener('click', function () {
        if (!a.onClick) return api.close();
        Promise.resolve(a.onClick(api)).catch(function (e) { toast(errMsg(e), 'error'); api.setBusy(false); });
      });
      bar.appendChild(b);
    });
    card.appendChild(bar);
    ovl.appendChild(card);
    ovl.addEventListener('mousedown', function (e) { if (e.target === ovl) api.close(); });
    document.body.appendChild(ovl);
    var api = {
      el: card,
      close: function () { ovl.remove(); },
      setBusy: function (busy) {
        Array.prototype.forEach.call(bar.querySelectorAll('button'), function (b) { b.disabled = !!busy; });
      },
    };
    return api;
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) node.appendChild(arguments[i]);
    return node;
  }

  function copyText(text) {
    var p = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('clipboard'));
    p.then(function () { toast('Copiado al portapapeles.', 'success'); })
      .catch(function () { window.prompt('Copia manualmente:', text); });
  }

  // ── Montaje raíz ─────────────────────────────────────────────────────────
  function build() {
    var shell = document.getElementById('wa-inbox-shell');
    if (!shell) return null;
    injectCss();
    state.shell = shell;
    state.built = true;
    return shell;
  }

  function show() {
    if (!state.built && !build()) return;
    getUid().then(function () {
      return loadAccount();
    }).then(function () {
      renderRoot();
      if (state.account) {
        subscribeRealtime();
        loadConversations();
        loadPendingFollowups();
      }
    }).catch(function (e) {
      state.shell.innerHTML = '';
      state.shell.appendChild(el('div', { class: 'wai-empty' },
        el('div', { class: 'empty-title', text: 'No se pudo cargar el inbox' }),
        el('div', { class: 'empty-sub', text: errMsg(e) })));
    });
  }

  function loadAccount() {
    // Nunca select('*'): las columnas de credenciales no tienen grant de
    // lectura y el comodín rompería la consulta.
    return sb().from('whatsapp_accounts')
      .select('id, phone_number_id, waba_id, display_phone, display_name, verify_token, status, last_error, created_at')
      .maybeSingle()
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        state.account = r.data || null;
      });
  }

  function renderRoot() {
    var shell = state.shell;
    shell.innerHTML = '';
    if (!state.account) { renderConnect(shell); return; }

    var acc = state.account;
    shell.appendChild(el('div', { class: 'wai-top' },
      el('div', { class: 'wai-top-title', text: 'Inbox WhatsApp' }),
      el('div', { class: 'wai-top-status' },
        el('span', { class: 'wai-dot' + (acc.status === 'error' ? ' err' : '') }),
        el('span', { text: (acc.display_phone || acc.phone_number_id) + (acc.display_name ? ' · ' + acc.display_name : '') })),
      el('div', { style: 'flex:1' }),
      (function () {
        var b = el('button', { class: 'btn btn-primary btn-sm', text: '+ Nueva conversación' });
        b.addEventListener('click', openNewConversationModal);
        return b;
      })(),
      (function () {
        var b = el('button', { class: 'btn btn-ghost btn-sm', text: '📋 Plantillas' });
        b.addEventListener('click', openManageTemplatesModal);
        return b;
      })(),
      (function () {
        var b = el('button', { class: 'btn btn-ghost btn-sm', text: '⚙ Conexión' });
        b.addEventListener('click', openSettingsModal);
        return b;
      })()));

    var left = el('div', { class: 'wai-left' });
    var head = el('div', { class: 'wai-left-head' });
    var search = el('input', { class: 'wai-search', type: 'search', placeholder: 'Buscar conversación…' });
    search.value = state.search;
    search.addEventListener('input', function () { state.search = search.value; renderConvList(); });
    var filters = el('div', { class: 'wai-filters' });
    [['all', 'Todas'], ['unread', 'No leídas'], ['followup', 'Con seguimiento']].forEach(function (f) {
      var b = el('button', { class: 'wai-chipbtn' + (state.filter === f[0] ? ' on' : ''), text: f[1] });
      b.addEventListener('click', function () {
        state.filter = f[0];
        Array.prototype.forEach.call(filters.children, function (c) { c.classList.remove('on'); });
        b.classList.add('on');
        renderConvList();
      });
      filters.appendChild(b);
    });
    head.appendChild(search);
    head.appendChild(filters);
    left.appendChild(head);
    left.appendChild(el('div', { class: 'wai-convlist', id: 'wai-convlist' }));

    var chat = el('div', { class: 'wai-chat', id: 'wai-chat' });
    var detail = el('div', { class: 'wai-detail', id: 'wai-detail' });

    var bodyRow = el('div', { class: 'wai-body' }, left, chat, detail);
    bodyRow.style.position = 'relative';
    shell.appendChild(bodyRow);

    renderConvList();
    renderChat();
    renderDetail();
  }

  // ── Vista de conexión (sin cuenta) ───────────────────────────────────────
  function renderConnect(shell) {
    shell.innerHTML = '';
    var wrap = el('div', { class: 'wai-connect-wrap' });
    var box = el('div', { class: 'wai-connect' });

    box.appendChild(el('div', null,
      el('div', { style: 'font-size:19px;font-weight:700;letter-spacing:-0.02em;color:var(--ink)', text: 'Conecta tu WhatsApp Business' }),
      el('div', { style: 'font-size:13px;color:var(--ink-3);margin-top:6px;line-height:1.6', text: 'Envía y recibe WhatsApp desde predictable.ai con la API oficial de Meta (Cloud API). Necesitas una cuenta gratuita de Meta for Developers — te toma unos 15 minutos la primera vez.' })));

    var steps = el('div', { class: 'card', style: 'padding:16px 18px' });
    steps.appendChild(el('div', { class: 'wai-d-title', style: 'margin-bottom:10px', text: 'Cómo obtener tus credenciales' }));
    var stepsBox = el('div', { class: 'wai-steps' });
    [
      'Entra a developers.facebook.com → "My Apps" → "Create app" y elige el tipo Business.',
      'Dentro de la app, agrega el producto "WhatsApp". Meta te crea un número de prueba; también puedes conectar tu número real desde "API Setup".',
      'En WhatsApp → API Setup copia el "Phone number ID" y el "WhatsApp Business Account ID" (WABA ID).',
      'Genera un token permanente: en Meta Business Suite → Configuración → Usuarios del sistema, crea un usuario del sistema, asígnale la app y el activo de WhatsApp, y genera un token con los permisos whatsapp_business_messaging y whatsapp_business_management. (El token de prueba de "API Setup" caduca en 24 h.)',
      'En App settings → Basic copia el "App secret" (verifica la firma de cada mensaje entrante).',
      'Pega todo aquí abajo y presiona "Conectar". Después te mostramos la URL del webhook para pegarla en Meta.',
    ].forEach(function (t) { stepsBox.appendChild(el('div', { class: 'wai-step', text: t })); });
    steps.appendChild(stepsBox);
    box.appendChild(steps);

    var form = el('div', { class: 'card', style: 'padding:16px 18px;display:flex;flex-direction:column;gap:12px' });
    function field(label, input, hint) {
      var f = el('div', { class: 'wai-field' }, el('label', { text: label }), input);
      if (hint) f.appendChild(el('div', { class: 'wai-hint', text: hint }));
      return f;
    }
    var inPnid = el('input', { type: 'text', placeholder: 'p. ej. 123456789012345', autocomplete: 'off' });
    var inWaba = el('input', { type: 'text', placeholder: 'p. ej. 987654321098765 (opcional, necesario para plantillas)', autocomplete: 'off' });
    var inToken = el('input', { type: 'password', placeholder: 'EAAG…', autocomplete: 'off' });
    var inSecret = el('input', { type: 'password', placeholder: 'App secret (App settings → Basic)', autocomplete: 'off' });
    form.appendChild(field('Phone number ID', inPnid));
    form.appendChild(field('WABA ID', inWaba));
    form.appendChild(field('Access token permanente', inToken, 'Se guarda cifrado en el backend y nunca vuelve al navegador.'));
    form.appendChild(field('App secret', inSecret));
    var btn = el('button', { class: 'btn btn-primary', style: 'justify-content:center', text: 'Conectar número' });
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Verificando con Meta…';
      edge('connect', {
        phone_number_id: inPnid.value.trim(),
        waba_id: inWaba.value.trim(),
        access_token: inToken.value.trim(),
        app_secret: inSecret.value.trim(),
      }).then(function (res) {
        toast('Número conectado: ' + (res.display_phone || ''), 'success');
        return loadAccount().then(function () {
          renderRoot();
          subscribeRealtime();
          loadConversations();
          openWebhookHelpModal();
        });
      }).catch(function (e) {
        toast(errMsg(e), 'error');
        btn.disabled = false;
        btn.textContent = 'Conectar número';
      });
    });
    form.appendChild(btn);
    box.appendChild(form);
    wrap.appendChild(box);
    shell.appendChild(wrap);
  }

  function webhookInfoNode() {
    var acc = state.account || {};
    var whUrl = window.SUPABASE_CONFIG.url + '/functions/v1/whatsapp-webhook';
    var box = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    box.appendChild(el('div', { class: 'wai-hint', text: 'Para recibir mensajes, configura el webhook en tu app de Meta (WhatsApp → Configuration → Webhook):' }));
    function codeRow(label, value) {
      var row = el('div', { class: 'wai-field' }, el('label', { text: label }));
      var code = el('div', { class: 'wai-code' });
      code.appendChild(el('span', { style: 'flex:1', text: value }));
      var cp = el('button', { class: 'btn btn-ghost btn-sm', text: 'Copiar' });
      cp.addEventListener('click', function () { copyText(value); });
      code.appendChild(cp);
      row.appendChild(code);
      return row;
    }
    box.appendChild(codeRow('Callback URL', whUrl));
    box.appendChild(codeRow('Verify token', acc.verify_token || ''));
    box.appendChild(el('div', { class: 'wai-hint', text: 'Después de verificar, en "Webhook fields" suscríbete al campo "messages". Sin esto no llegan los mensajes entrantes ni los estados de entrega.' }));
    return box;
  }

  function openWebhookHelpModal() {
    openModal('Último paso: el webhook', webhookInfoNode(), [{ label: 'Listo', className: 'btn btn-primary btn-sm' }]);
  }

  function openSettingsModal() {
    var acc = state.account || {};
    var body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    body.appendChild(el('div', { class: 'wai-d-row' },
      el('div', { class: 'wai-d-lbl', text: 'Número conectado' }),
      el('div', { class: 'wai-d-val', text: (acc.display_phone || acc.phone_number_id || '—') + (acc.display_name ? ' · ' + acc.display_name : '') })));
    if (acc.last_error) {
      body.appendChild(el('div', { style: 'font-size:12px;color:var(--red)', text: 'Último error: ' + acc.last_error }));
    }
    body.appendChild(webhookInfoNode());
    var disc = el('button', { class: 'btn btn-ghost btn-sm', style: 'color:var(--red);align-self:flex-start', text: 'Desconectar número' });
    disc.addEventListener('click', function () {
      if (!window.confirm('¿Desconectar tu número de WhatsApp? Las conversaciones guardadas no se borran, pero dejarás de enviar y recibir.')) return;
      edge('disconnect', {}).then(function () {
        toast('Número desconectado.', 'info');
        unsubscribeRealtime();
        state.account = null;
        state.conversations = [];
        state.activeConvId = null;
        renderRoot();
      }).catch(function (e) { toast(errMsg(e), 'error'); });
    });
    body.appendChild(disc);
    openModal('Conexión de WhatsApp', body, [{ label: 'Cerrar', className: 'btn btn-primary btn-sm' }]);
  }

  // ── Conversaciones ───────────────────────────────────────────────────────
  function loadConversations() {
    state.convsLoading = true;
    state.convError = null;
    sb().from('whatsapp_conversations')
      .select('*')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(300)
      .then(function (r) {
        state.convsLoading = false;
        if (r.error) { state.convError = r.error.message; renderConvList(); return; }
        state.conversations = r.data || [];
        refreshBadge();
        return loadMemberNames().then(renderConvList);
      });
  }

  function loadMemberNames() {
    var ids = state.conversations.map(function (c) { return c.member_id; }).filter(Boolean)
      .filter(function (id) { return !state.memberNames[id]; });
    if (!ids.length) return Promise.resolve();
    return sb().from('prospect_list_members')
      .select('id, name, first_name, last_name, title, company')
      .in('id', ids)
      .then(function (r) {
        (r.data || []).forEach(function (m) {
          state.memberNames[m.id] = {
            name: m.name || [m.first_name, m.last_name].filter(Boolean).join(' '),
            title: m.title, company: m.company,
          };
        });
      });
  }

  function loadPendingFollowups() {
    sb().from('whatsapp_followups')
      .select('id, conversation_id, status')
      .eq('status', 'pending')
      .then(function (r) {
        var map = {};
        (r.data || []).forEach(function (f) { map[f.conversation_id] = (map[f.conversation_id] || 0) + 1; });
        state.pendingFu = map;
        renderConvList();
      });
  }

  function visibleConversations() {
    var q = state.search.trim().toLowerCase();
    return state.conversations.filter(function (c) {
      if (state.filter === 'unread' && !(c.unread_count > 0)) return false;
      if (state.filter === 'followup' && !state.pendingFu[c.id]) return false;
      if (!q) return true;
      var hay = (convName(c) + ' ' + c.wa_id + ' ' + (c.last_message_preview || '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function renderConvList() {
    var host = document.getElementById('wai-convlist');
    if (!host) return;
    host.innerHTML = '';
    if (state.convsLoading && !state.conversations.length) {
      host.innerHTML = window.Skeleton ? window.Skeleton.listRows(6, { avatar: true }) : '';
      return;
    }
    if (state.convError) {
      host.appendChild(el('div', { class: 'wai-empty' }, el('div', { class: 'empty-sub', text: state.convError })));
      return;
    }
    var convs = visibleConversations();
    if (!convs.length) {
      host.appendChild(el('div', { class: 'wai-empty' },
        el('div', { class: 'empty-title', text: state.conversations.length ? 'Sin resultados' : 'Aún no hay conversaciones' }),
        el('div', { class: 'empty-sub', text: state.conversations.length ? 'Prueba con otra búsqueda o filtro.' : 'Escribe a un contacto de tus Listas con "+ Nueva conversación", o espera un mensaje entrante.' })));
      return;
    }
    convs.forEach(function (c) {
      var name = convName(c);
      var item = el('div', { class: 'wai-conv' + (c.id === state.activeConvId ? ' on' : '') });
      var av = el('div', { class: 'wai-avatar', text: initialsOf(name) });
      av.setAttribute('style', avatarStyle(c.wa_id));
      var prevPrefix = c.last_message_direction === 'out' ? 'Tú: ' : '';
      item.appendChild(av);
      item.appendChild(el('div', { class: 'wai-conv-main' },
        el('div', { class: 'wai-conv-top' },
          el('div', { class: 'wai-conv-name', text: name }),
          el('div', { class: 'wai-conv-time', text: fmtRel(c.last_message_at) })),
        el('div', { class: 'wai-conv-bottom' },
          el('div', { class: 'wai-conv-preview', text: prevPrefix + (c.last_message_preview || 'Sin mensajes') }),
          state.pendingFu[c.id] ? el('span', { class: 'wai-fu-flag', title: 'Seguimiento programado', text: '⏰' }) : null,
          c.unread_count > 0 ? el('span', { class: 'wai-unread', text: String(c.unread_count) }) : null)));
      item.addEventListener('click', function () { selectConversation(c.id); });
      host.appendChild(item);
    });
  }

  function activeConv() {
    return state.conversations.find(function (c) { return c.id === state.activeConvId; }) || null;
  }

  function selectConversation(id) {
    state.activeConvId = id;
    state.replyTo = null;
    clearAttach();
    state.messages = [];
    state.hasOlder = false;
    state.member = null;
    state.followups = [];
    renderConvList();
    renderChat();
    renderDetail();
    loadMessages();
    loadDetail();
    var c = activeConv();
    if (c && c.unread_count > 0) {
      c.unread_count = 0;
      renderConvList();
      refreshBadge();
      edge('mark_read', { conversation_id: id }).catch(function () {});
    }
  }

  // ── Mensajes ─────────────────────────────────────────────────────────────
  function loadMessages(older) {
    var convId = state.activeConvId;
    if (!convId) return;
    state.msgsLoading = true;
    var q = sb().from('whatsapp_messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('sent_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (older && state.messages.length) q = q.lt('sent_at', state.messages[0].sent_at);
    q.then(function (r) {
      state.msgsLoading = false;
      if (convId !== state.activeConvId) return;
      if (r.error) { toast(r.error.message, 'error'); return; }
      var batch = (r.data || []).reverse();
      state.hasOlder = (r.data || []).length === PAGE_SIZE;
      state.messages = older ? batch.concat(state.messages) : batch;
      renderThread(!older);
      renderWindowNote();
    });
  }

  function findMsg(id) {
    return state.messages.find(function (m) { return m.id === id; }) || null;
  }
  function findMsgByWamid(wamid) {
    return state.messages.find(function (m) { return m.wamid && m.wamid === wamid; }) || null;
  }

  function ticksHtml(m) {
    if (m.direction !== 'out') return '';
    if (m.status === 'failed') return '<span class="wai-ticks failed" title="' + esc(m.error_detail || 'Falló el envío') + '">⚠</span>';
    if (m.status === 'pending') return '<span class="wai-ticks" title="Enviando…">🕓</span>';
    if (m.status === 'sent') return '<span class="wai-ticks" title="Enviado">✓</span>';
    var read = m.status === 'read';
    return '<span class="wai-ticks' + (read ? ' read' : '') + '" title="' + (read ? 'Leído' : 'Entregado') + '">✓✓</span>';
  }

  function mediaHtml(m) {
    if (!m.media_path) return '';
    var url = esc(mediaUrl(m.media_path));
    var mime = String(m.media_mime || '');
    if (m.type === 'image' || m.type === 'sticker' || mime.indexOf('image/') === 0) {
      return '<img class="wai-media-img" src="' + url + '" alt="Imagen" loading="lazy" data-waopen="' + url + '">';
    }
    if (m.type === 'video' || mime.indexOf('video/') === 0) {
      return '<video class="wai-media-video" controls preload="metadata" src="' + url + '"></video>';
    }
    if (m.type === 'audio' || mime.indexOf('audio/') === 0) {
      return '<audio class="wai-media-audio" controls preload="metadata" src="' + url + '"></audio>';
    }
    return '<a class="wai-doc" href="' + url + '" target="_blank" rel="noopener">📄 <span>' + esc(m.media_filename || 'Documento') + '</span></a>';
  }

  function quoteHtml(m) {
    if (!m.reply_to_wamid) return '';
    var q = findMsgByWamid(m.reply_to_wamid);
    var who = q ? (q.direction === 'out' ? 'Tú' : convName(activeConv() || {})) : '';
    var snippet = q ? (q.body || ({ image: '📷 Foto', video: '🎬 Video', audio: '🎤 Audio', document: '📄 Documento' }[q.type] || 'Mensaje')) : 'Mensaje citado';
    return '<div class="wai-quote"><b>' + esc(who) + '</b>' + esc(String(snippet).slice(0, 140)) + '</div>';
  }

  function reactionsHtml(m) {
    var rx = Array.isArray(m.reactions) ? m.reactions : [];
    if (!rx.length) return '';
    return '<div class="wai-reactions">' + rx.map(function (r) {
      return '<span class="wai-reaction-chip" title="' + (r.from === 'out' ? 'Tu reacción' : 'Reacción del contacto') + '">' + esc(r.emoji) + '</span>';
    }).join('') + '</div>';
  }

  function bubbleHtml(m) {
    var cls = 'wai-msg ' + (m.direction === 'out' ? 'out' : 'in');
    var actions =
      '<div class="wai-msg-actions">' +
      '<button class="wai-mact" data-waact="react" data-id="' + esc(m.id) + '" title="Reaccionar">😊</button>' +
      (m.wamid ? '<button class="wai-mact" data-waact="reply" data-id="' + esc(m.id) + '" title="Responder">↩</button>' : '') +
      '</div>';
    var bodyHtml = '';
    if (m.body) bodyHtml = '<div class="wai-msg-body">' + esc(m.body) + '</div>';
    else if (m.type === 'template') bodyHtml = '<div class="wai-msg-body" style="font-style:italic">Plantilla enviada</div>';
    return '<div class="' + cls + '" data-msgid="' + esc(m.id) + '">' +
      actions +
      '<div class="wai-bubble">' +
        quoteHtml(m) +
        mediaHtml(m) +
        bodyHtml +
        '<div class="wai-msg-meta">' +
          (m.type === 'template' ? '<span title="Enviado como plantilla">📋</span>' : '') +
          '<span>' + esc(fmtTime(m.sent_at)) + '</span>' + ticksHtml(m) +
        '</div>' +
      '</div>' +
      (m.status === 'failed' && m.error_detail ? '<div class="wai-failed-note">' + esc(m.error_detail) + '</div>' : '') +
      reactionsHtml(m) +
      '</div>';
  }

  function renderThread(scrollBottom) {
    var threadEl = document.getElementById('wai-thread');
    if (!threadEl) return;
    var html = '';
    if (state.hasOlder) {
      html += '<button class="btn btn-ghost btn-sm" style="align-self:center;margin-bottom:8px" data-waact="older">Cargar mensajes anteriores</button>';
    }
    var prevDay = null;
    state.messages.forEach(function (m) {
      var day = fmtDaySep(m.sent_at);
      if (day !== prevDay) {
        html += '<div class="wai-daysep">' + esc(day) + '</div>';
        prevDay = day;
      }
      html += bubbleHtml(m);
    });
    if (!state.messages.length && !state.msgsLoading) {
      html = '<div class="wai-empty"><div class="empty-title">Sin mensajes todavía</div><div class="empty-sub">Escribe abajo para iniciar la conversación. Si el contacto nunca te ha escrito, WhatsApp puede requerir una plantilla aprobada.</div></div>';
    }
    var prevScroll = threadEl.scrollHeight - threadEl.scrollTop;
    threadEl.innerHTML = html;
    if (scrollBottom !== false) threadEl.scrollTop = threadEl.scrollHeight;
    else threadEl.scrollTop = threadEl.scrollHeight - prevScroll;
  }

  function patchMessageInPlace(row) {
    var i = state.messages.findIndex(function (m) { return m.id === row.id; });
    if (i === -1) return false;
    state.messages[i] = row;
    var node = document.querySelector('[data-msgid="' + row.id + '"]');
    if (node) {
      var tmp = document.createElement('div');
      tmp.innerHTML = bubbleHtml(row);
      node.replaceWith(tmp.firstChild);
    }
    return true;
  }

  function appendMessage(row) {
    if (findMsg(row.id)) { patchMessageInPlace(row); return; }
    state.messages.push(row);
    var threadEl = document.getElementById('wai-thread');
    if (!threadEl) return;
    var nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 160;
    renderThread(nearBottom || row.direction === 'out');
  }

  // ── Chat (columna central) ───────────────────────────────────────────────
  function renderChat() {
    var chat = document.getElementById('wai-chat');
    if (!chat) return;
    chat.innerHTML = '';
    var c = activeConv();
    if (!c) {
      chat.appendChild(el('div', { class: 'wai-empty' },
        el('div', { style: 'font-size:34px;opacity:.35', text: '💬' }),
        el('div', { class: 'empty-title', text: 'Elige una conversación' }),
        el('div', { class: 'empty-sub', text: 'O inicia una nueva con un contacto de tus Listas de prospección.' })));
      return;
    }
    var name = convName(c);
    var headAv = el('div', { class: 'wai-avatar', text: initialsOf(name) });
    headAv.setAttribute('style', avatarStyle(c.wa_id) + ';width:32px;height:32px;font-size:12px');
    var head = el('div', { class: 'wai-chat-head' },
      headAv,
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'wai-chat-head-name', text: name }),
        el('div', { class: 'wai-chat-head-sub', text: '+' + c.wa_id })),
      (function () {
        var b = el('button', { class: 'btn btn-ghost btn-sm', text: '⏰ Seguimiento' });
        b.addEventListener('click', function () { openScheduleModal(); });
        return b;
      })(),
      (function () {
        var b = el('button', { class: 'btn btn-ghost btn-sm', text: 'ℹ️', title: 'Ficha del contacto' });
        b.addEventListener('click', function () {
          state.detailOpen = !state.detailOpen;
          var d = document.getElementById('wai-detail');
          if (d) d.classList.toggle('force', state.detailOpen);
          renderDetail();
        });
        return b;
      })());
    chat.appendChild(head);

    var thread = el('div', { class: 'wai-thread', id: 'wai-thread' });
    thread.addEventListener('click', onThreadClick);
    chat.appendChild(thread);
    chat.appendChild(el('div', { id: 'wai-window-note' }));
    chat.appendChild(buildComposer());
    renderThread(true);
    renderWindowNote();
  }

  function lastInboundAt() {
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].direction === 'in') return new Date(state.messages[i].sent_at).getTime();
    }
    return 0;
  }

  function renderWindowNote() {
    var host = document.getElementById('wai-window-note');
    if (!host) return;
    host.innerHTML = '';
    if (!state.activeConvId || state.msgsLoading) return;
    var last = lastInboundAt();
    var outside = !last || (Date.now() - last) > 24 * 3600 * 1000;
    if (!outside) return;
    host.innerHTML = '<div class="wai-window-note">⚠️ <span>' +
      esc(last
        ? 'El contacto no escribe hace más de 24 h. WhatsApp solo acepta mensajes libres dentro de la ventana de 24 h — si el envío falla, usa una plantilla aprobada (botón 📋).'
        : 'Este contacto aún no te ha escrito. Para el primer mensaje WhatsApp exige una plantilla aprobada (botón 📋); los mensajes libres se habilitan cuando el contacto responde.') +
      '</span></div>';
  }

  function onThreadClick(e) {
    var open = e.target.closest ? e.target.closest('[data-waopen]') : null;
    if (open) { window.open(sUrl(open.getAttribute('data-waopen')), '_blank', 'noopener'); return; }
    var btn = e.target.closest ? e.target.closest('[data-waact]') : null;
    if (!btn) { closeReactPop(); return; }
    var act = btn.getAttribute('data-waact');
    if (act === 'older') return loadMessages(true);
    var m = findMsg(btn.getAttribute('data-id'));
    if (act === 'reply' && m) {
      state.replyTo = m;
      renderReplyBar();
      var input = document.getElementById('wai-input');
      if (input) input.focus();
    }
    if (act === 'react' && m) openReactPop(m, btn);
  }

  var reactPopEl = null;
  function closeReactPop() { if (reactPopEl) { reactPopEl.remove(); reactPopEl = null; } }
  function openReactPop(m, anchorBtn) {
    closeReactPop();
    var msgNode = anchorBtn.closest('.wai-msg');
    if (!msgNode) return;
    var pop = document.createElement('div');
    pop.className = 'wai-reactpop';
    var mine = (Array.isArray(m.reactions) ? m.reactions : []).find(function (r) { return r.from === 'out'; });
    REACT_EMOJIS.forEach(function (emo) {
      var b = document.createElement('button');
      b.textContent = emo;
      b.addEventListener('click', function () {
        closeReactPop();
        sendReaction(m, mine && mine.emoji === emo ? '' : emo);
      });
      pop.appendChild(b);
    });
    if (mine) {
      var rm = document.createElement('button');
      rm.textContent = '✕';
      rm.title = 'Quitar reacción';
      rm.addEventListener('click', function () { closeReactPop(); sendReaction(m, ''); });
      pop.appendChild(rm);
    }
    msgNode.appendChild(pop);
    reactPopEl = pop;
  }

  function sendReaction(m, emoji) {
    edge('react', { message_id: m.id, emoji: emoji }).then(function (res) {
      m.reactions = res.reactions || [];
      patchMessageInPlace(m);
    }).catch(function (e) { toast(errMsg(e), 'error'); });
  }

  // ── Composer ─────────────────────────────────────────────────────────────
  function buildComposer() {
    var wrap = el('div', { class: 'wai-composer', id: 'wai-composer' });
    wrap.style.position = 'relative';
    wrap.appendChild(el('div', { id: 'wai-replybar-host' }));
    wrap.appendChild(el('div', { id: 'wai-attachbar-host' }));

    var row = el('div', { class: 'wai-comp-row', id: 'wai-comp-row' });

    var fileIn = el('input', { type: 'file', style: 'display:none', id: 'wai-file' });
    fileIn.setAttribute('accept', 'image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt');
    fileIn.addEventListener('change', function () {
      if (fileIn.files && fileIn.files[0]) setAttach(fileIn.files[0]);
      fileIn.value = '';
    });

    var attachBtn = el('button', { class: 'wai-iconbtn', title: 'Adjuntar archivo', text: '📎' });
    attachBtn.addEventListener('click', function () { fileIn.click(); });

    var emojiBtn = el('button', { class: 'wai-iconbtn', title: 'Emojis', text: '🙂' });
    emojiBtn.addEventListener('click', toggleEmojiPop);

    var tplBtn = el('button', { class: 'wai-iconbtn', title: 'Plantillas aprobadas (necesarias fuera de la ventana de 24 h)', text: '📋' });
    tplBtn.addEventListener('click', openTemplatesModal);

    var input = el('textarea', { class: 'wai-input', id: 'wai-input', rows: '1', placeholder: 'Escribe un mensaje…' });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

    var micBtn = el('button', { class: 'wai-iconbtn', id: 'wai-mic', title: 'Grabar nota de voz', text: '🎤' });
    micBtn.addEventListener('click', toggleRecording);

    var sendBtn = el('button', { class: 'wai-sendbtn', id: 'wai-sendbtn', title: 'Enviar', text: '➤' });
    sendBtn.addEventListener('click', doSend);

    row.appendChild(fileIn);
    row.appendChild(attachBtn);
    row.appendChild(emojiBtn);
    row.appendChild(tplBtn);
    row.appendChild(input);
    row.appendChild(micBtn);
    row.appendChild(sendBtn);
    wrap.appendChild(row);
    return wrap;
  }

  function renderReplyBar() {
    var host = document.getElementById('wai-replybar-host');
    if (!host) return;
    host.innerHTML = '';
    if (!state.replyTo) return;
    var m = state.replyTo;
    var snippet = m.body || ({ image: '📷 Foto', video: '🎬 Video', audio: '🎤 Audio', document: '📄 Documento' }[m.type] || 'Mensaje');
    var bar = el('div', { class: 'wai-replybar' },
      el('div', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
        el('b', { style: 'color:var(--accent-ink);font-size:11px;display:block', text: 'Respondiendo a ' + (m.direction === 'out' ? 'ti' : convName(activeConv() || {})) }),
        el('span', { text: String(snippet).slice(0, 120) })),
      (function () {
        var x = el('button', { class: 'wai-iconbtn', style: 'width:26px;height:26px;font-size:13px', text: '✕' });
        x.addEventListener('click', function () { state.replyTo = null; renderReplyBar(); });
        return x;
      })());
    host.appendChild(bar);
  }

  function kindForFile(file) {
    var t = String(file.type || '');
    if (t.indexOf('image/') === 0) return 'image';
    if (t.indexOf('video/') === 0) return 'video';
    if (t.indexOf('audio/') === 0) return 'audio';
    return 'document';
  }

  function setAttach(file, forcedKind) {
    var kind = forcedKind || kindForFile(file);
    var limit = SIZE_LIMITS[kind] || SIZE_LIMITS.document;
    if (file.size > limit) {
      toast('El archivo supera el límite de WhatsApp (' + Math.round(limit / 1024 / 1024) + ' MB para ' + kind + ').', 'warn');
      return;
    }
    clearAttach();
    state.attach = { file: file, kind: kind };
    renderAttachBar();
  }

  function clearAttach() {
    state.attach = null;
    var host = document.getElementById('wai-attachbar-host');
    if (host) host.innerHTML = '';
  }

  function renderAttachBar() {
    var host = document.getElementById('wai-attachbar-host');
    if (!host) return;
    host.innerHTML = '';
    if (!state.attach) return;
    var f = state.attach.file;
    var icon = { image: '📷', video: '🎬', audio: '🎤', document: '📄' }[state.attach.kind] || '📄';
    var bar = el('div', { class: 'wai-attachbar' },
      el('span', { text: icon }),
      el('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: f.name + ' · ' + (f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.ceil(f.size / 1024) + ' KB') }),
      (function () {
        var x = el('button', { class: 'wai-iconbtn', style: 'width:26px;height:26px;font-size:13px', text: '✕' });
        x.addEventListener('click', clearAttach);
        return x;
      })());
    host.appendChild(bar);
  }

  var emojiPopEl = null;
  function toggleEmojiPop() {
    if (emojiPopEl) { emojiPopEl.remove(); emojiPopEl = null; return; }
    var comp = document.getElementById('wai-composer');
    var input = document.getElementById('wai-input');
    if (!comp || !input) return;
    var pop = document.createElement('div');
    pop.className = 'wai-emojipop';
    COMPOSER_EMOJIS.forEach(function (emo) {
      var b = document.createElement('button');
      b.textContent = emo;
      b.addEventListener('click', function () {
        var s = input.selectionStart || input.value.length;
        input.value = input.value.slice(0, s) + emo + input.value.slice(input.selectionEnd || s);
        input.focus();
        input.selectionStart = input.selectionEnd = s + emo.length;
      });
      pop.appendChild(b);
    });
    comp.appendChild(pop);
    emojiPopEl = pop;
  }

  // ── Grabación de audio ───────────────────────────────────────────────────
  function pickAudioMime() {
    if (!window.MediaRecorder) return null;
    var candidates = ['audio/ogg;codecs=opus', 'audio/mp4', 'audio/mpeg', 'audio/webm;codecs=opus', 'audio/webm'];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  function toggleRecording() {
    if (state.rec) { stopRecording(false); return; }
    var mime = pickAudioMime();
    if (!mime) { toast('Tu navegador no soporta grabación de audio. Adjunta un archivo de audio con 📎.', 'warn'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var recorder = new MediaRecorder(stream, { mimeType: mime });
      var chunks = [];
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var rec = state.rec;
        state.rec = null;
        renderRecUi();
        if (!rec || rec.cancelled) return;
        var base = mime.split(';')[0];
        var ext = { 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'webm' }[base] || 'bin';
        var file = new File(chunks, 'nota-de-voz.' + ext, { type: base });
        // WhatsApp no acepta webm como audio — se envía como documento.
        var kind = base === 'audio/webm' ? 'document' : 'audio';
        if (kind === 'document') toast('Tu navegador graba en formato webm; WhatsApp lo recibirá como archivo, no como nota de voz.', 'info');
        setAttach(file, kind);
      };
      recorder.start(250);
      state.rec = { recorder: recorder, chunks: chunks, t0: Date.now(), cancelled: false, timer: setInterval(renderRecUi, 500) };
      renderRecUi();
    }).catch(function () {
      toast('No se pudo acceder al micrófono. Revisa los permisos del navegador.', 'error');
    });
  }

  function stopRecording(cancel) {
    var rec = state.rec;
    if (!rec) return;
    rec.cancelled = !!cancel;
    clearInterval(rec.timer);
    try { rec.recorder.stop(); } catch (e) { /* ya detenido */ }
  }

  function renderRecUi() {
    var row = document.getElementById('wai-comp-row');
    if (!row) return;
    var input = document.getElementById('wai-input');
    var mic = document.getElementById('wai-mic');
    var old = document.getElementById('wai-recbar');
    if (!state.rec) {
      if (old) old.remove();
      if (input) input.style.display = '';
      if (mic) { mic.classList.remove('rec'); mic.textContent = '🎤'; mic.title = 'Grabar nota de voz'; }
      return;
    }
    if (input) input.style.display = 'none';
    if (mic) { mic.classList.add('rec'); mic.textContent = '⏹'; mic.title = 'Detener y adjuntar'; }
    var secs = Math.floor((Date.now() - state.rec.t0) / 1000);
    var mm = String(Math.floor(secs / 60)).padStart(2, '0');
    var ss = String(secs % 60).padStart(2, '0');
    if (!old) {
      old = el('div', { class: 'wai-recbar', id: 'wai-recbar' },
        el('span', { class: 'wai-recdot' }),
        el('span', { id: 'wai-rectime', text: '00:00' }),
        el('span', { style: 'color:var(--ink-3)', text: 'Grabando…' }),
        (function () {
          var x = el('button', { class: 'btn btn-ghost btn-sm', text: 'Cancelar' });
          x.addEventListener('click', function () { stopRecording(true); });
          return x;
        })());
      row.insertBefore(old, mic);
    }
    var t = document.getElementById('wai-rectime');
    if (t) t.textContent = mm + ':' + ss;
  }

  // ── Envío ────────────────────────────────────────────────────────────────
  function doSend() {
    if (state.sending) return;
    var conv = activeConv();
    if (!conv) return;
    if (state.rec) { stopRecording(false); return; }
    var input = document.getElementById('wai-input');
    var text = input ? input.value.trim() : '';
    var attach = state.attach;
    if (!text && !attach) return;

    var sendBtn = document.getElementById('wai-sendbtn');
    state.sending = true;
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }

    var uploaded = Promise.resolve(null);
    if (attach) {
      var extGuess = (attach.file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
      var path = state.uid + '/' + conv.id + '/' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) + '.' + extGuess;
      uploaded = sb().storage.from(BUCKET)
        .upload(path, attach.file, { contentType: attach.file.type || 'application/octet-stream', upsert: false })
        .then(function (r) {
          if (r.error) throw new Error('No se pudo subir el archivo: ' + r.error.message);
          return { path: path, mime: attach.file.type, filename: attach.file.name, kind: attach.kind };
        });
    }

    // WhatsApp no soporta caption en audios: el texto va como mensaje aparte.
    var audioPlusText = attach && attach.kind === 'audio' && !!text;

    uploaded.then(function (media) {
      return edge('send', {
        conversation_id: conv.id,
        kind: media ? media.kind : 'text',
        body: audioPlusText ? null : (text || null),
        media_path: media ? media.path : null,
        media_mime: media ? media.mime : null,
        media_filename: media ? media.filename : null,
        reply_to_wamid: state.replyTo ? state.replyTo.wamid : null,
      });
    }).then(function (res) {
      if (audioPlusText) {
        if (res && res.message) appendMessage(res.message);
        return edge('send', { conversation_id: conv.id, kind: 'text', body: text });
      }
      return res;
    }).then(function (res) {
      if (input) { input.value = ''; input.style.height = 'auto'; }
      state.replyTo = null;
      renderReplyBar();
      clearAttach();
      if (res && res.message) appendMessage(res.message);
      var c = activeConv();
      if (c) {
        c.last_message_at = new Date().toISOString();
        c.last_message_preview = text || 'Adjunto';
        c.last_message_direction = 'out';
        sortConversations();
        renderConvList();
      }
      renderWindowNote();
    }).catch(function (e) {
      toast(errMsg(e), 'error');
    }).then(function () {
      state.sending = false;
      var b = document.getElementById('wai-sendbtn');
      if (b) { b.disabled = false; b.textContent = '➤'; }
    });
  }

  function sortConversations() {
    state.conversations.sort(function (a, b) {
      return String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''));
    });
  }

  // ── Plantillas ───────────────────────────────────────────────────────────
  function openTemplatesModal() {
    var conv = activeConv();
    if (!conv) return;
    var body = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    body.appendChild(el('div', { class: 'wai-hint', text: 'Las plantillas aprobadas por Meta son la única forma de escribir fuera de la ventana de 24 horas (por ejemplo, el primer mensaje a un prospecto que nunca te ha escrito). Créalas en Meta Business Suite → WhatsApp Manager.' }));
    var listHost = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    listHost.innerHTML = window.Skeleton ? window.Skeleton.listRows(3, { avatar: false }) : 'Cargando…';
    body.appendChild(listHost);
    var modal = openModal('Enviar plantilla', body, [{ label: 'Cerrar', className: 'btn btn-ghost btn-sm' }]);

    edge('templates', {}).then(function (res) {
      listHost.innerHTML = '';
      var tpls = (res && res.templates) || [];
      if (!tpls.length) {
        listHost.appendChild(el('div', { class: 'wai-hint', text: 'No tienes plantillas aprobadas todavía. Crea una en WhatsApp Manager (la categoría "Marketing" o "Utility" tarda minutos en aprobarse).' }));
        return;
      }
      tpls.forEach(function (t) {
        var item = el('div', { class: 'wai-fu-item', style: 'cursor:pointer' },
          el('div', { class: 'wai-fu-when', text: t.name + ' · ' + t.language + (t.category ? ' · ' + t.category : '') }),
          el('div', { class: 'wai-fu-body', text: t.body || '(sin cuerpo)' }));
        item.addEventListener('click', function () { modal.close(); openTemplateParamsModal(conv, t); });
        listHost.appendChild(item);
      });
    }).catch(function (e) {
      listHost.innerHTML = '';
      listHost.appendChild(el('div', { style: 'font-size:12px;color:var(--red)', text: errMsg(e) }));
    });
  }

  function openTemplateParamsModal(conv, tpl) {
    var placeholders = [];
    var re = /\{\{(\d+)\}\}/g, m;
    while ((m = re.exec(tpl.body || '')) !== null) {
      var n = parseInt(m[1], 10);
      if (placeholders.indexOf(n) === -1) placeholders.push(n);
    }
    placeholders.sort(function (a, b) { return a - b; });

    var body = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    body.appendChild(el('div', { class: 'wai-fu-item' },
      el('div', { class: 'wai-fu-when', text: tpl.name + ' · ' + tpl.language }),
      el('div', { class: 'wai-fu-body', text: tpl.body || '' })));
    var inputs = [];
    placeholders.forEach(function (n) {
      var input = el('input', { type: 'text', placeholder: 'Valor para {{' + n + '}}' });
      inputs.push(input);
      body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Variable {{' + n + '}}' }), input));
    });

    openModal('Enviar "' + tpl.name + '"', body, [
      { label: 'Cancelar', className: 'btn btn-ghost btn-sm' },
      {
        label: 'Enviar plantilla', className: 'btn btn-primary btn-sm',
        onClick: function (api) {
          var params = inputs.map(function (i) { return i.value.trim(); });
          if (params.some(function (v) { return !v; })) { toast('Completa todas las variables.', 'warn'); return; }
          api.setBusy(true);
          var preview = String(tpl.body || '');
          placeholders.forEach(function (n, i) { preview = preview.split('{{' + n + '}}').join(params[i]); });
          return edge('send_template', {
            conversation_id: conv.id,
            template_name: tpl.name,
            language: tpl.language,
            body_params: params,
            preview_body: preview,
          }).then(function (res) {
            api.close();
            if (res && res.message) appendMessage(res.message);
            toast('Plantilla enviada.', 'success');
          });
        },
      },
    ]);
  }

  // ── Gestión de plantillas (crear + enviar a Meta para aprobación) ───────
  var TEMPLATE_STATUS_LABEL = {
    PENDING: 'En revisión', APPROVED: 'Aprobada', REJECTED: 'Rechazada',
    PAUSED: 'Pausada', DISABLED: 'Deshabilitada', IN_APPEAL: 'En apelación',
  };
  var TEMPLATE_STATUS_COLOR = {
    PENDING: 'var(--amber)', APPROVED: 'var(--green)', REJECTED: 'var(--red)',
    PAUSED: 'var(--red)', DISABLED: 'var(--red)', IN_APPEAL: 'var(--amber)',
  };
  var TEMPLATE_LANGS = [
    ['es_MX', 'Español (México)'], ['es', 'Español'], ['es_AR', 'Español (Argentina)'],
    ['es_CO', 'Español (Colombia)'], ['es_ES', 'Español (España)'], ['en_US', 'Inglés (EE. UU.)'],
    ['pt_BR', 'Portugués (Brasil)'],
  ];

  function extractVarsClient(text) {
    var found = [], re = /\{\{(\d+)\}\}/g, m;
    while ((m = re.exec(text || '')) !== null) {
      var n = parseInt(m[1], 10);
      if (found.indexOf(n) === -1) found.push(n);
    }
    found.sort(function (a, b) { return a - b; });
    return found;
  }

  function openManageTemplatesModal() {
    var body = el('div', { style: 'display:flex;flex-direction:column;gap:10px;min-width:340px' });
    body.appendChild(el('div', { class: 'wai-hint', text: 'Crea plantillas y envíalas a Meta para su aprobación. Solo se pueden usar para enviar mensajes (primer contacto o fuera de la ventana de 24 h) una vez que Meta las aprueba — puede tardar minutos u horas.' }));

    var newBtn = el('button', { class: 'btn btn-primary btn-sm', text: '+ Nueva plantilla' });
    var syncBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '🔄 Actualizar estado' });
    body.appendChild(el('div', { style: 'display:flex;gap:8px' }, newBtn, syncBtn));

    var listHost = el('div', { style: 'display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow:auto' });
    listHost.innerHTML = window.Skeleton ? window.Skeleton.listRows(3, { avatar: false }) : 'Cargando…';
    body.appendChild(listHost);

    function renderList(templates) {
      listHost.innerHTML = '';
      if (!templates.length) {
        listHost.appendChild(el('div', { class: 'wai-hint', text: 'Aún no has creado ninguna plantilla.' }));
        return;
      }
      templates.forEach(function (t) {
        var statusEl = el('span', {
          style: 'font-size:11px;font-weight:700;color:' + (TEMPLATE_STATUS_COLOR[t.status] || 'var(--accent-ink)'),
          text: TEMPLATE_STATUS_LABEL[t.status] || t.status,
        });
        var head = el('div', { style: 'display:flex;align-items:center;gap:8px;justify-content:space-between' },
          el('div', { class: 'wai-fu-when', text: t.name + ' · ' + t.language + ' · ' + t.category }),
          statusEl);
        var bodyComp = (Array.isArray(t.components) ? t.components : []).filter(function (c) { return c && c.type === 'BODY'; })[0];
        var item = el('div', { class: 'wai-fu-item' },
          head,
          el('div', { class: 'wai-fu-body', text: (bodyComp && bodyComp.text) || '' }));
        if (t.status === 'REJECTED' && t.rejection_reason) {
          item.appendChild(el('div', { style: 'font-size:11px;color:var(--red)', text: 'Motivo: ' + t.rejection_reason }));
        }
        var del = el('button', { class: 'btn btn-ghost btn-sm', style: 'color:var(--red);align-self:flex-start;margin-top:4px', text: 'Eliminar' });
        del.addEventListener('click', function () {
          if (!window.confirm('¿Eliminar la plantilla "' + t.name + '"? Esto también la borra de Meta.')) return;
          del.disabled = true;
          edge('template_delete', { id: t.id }).then(function () {
            toast('Plantilla eliminada.', 'info');
            return reload();
          }).catch(function (e) { toast(errMsg(e), 'error'); del.disabled = false; });
        });
        item.appendChild(del);
        listHost.appendChild(item);
      });
    }

    function reload() {
      listHost.innerHTML = window.Skeleton ? window.Skeleton.listRows(3, { avatar: false }) : 'Cargando…';
      return edge('template_list', {}).then(function (res) {
        renderList((res && res.templates) || []);
      }).catch(function (e) {
        listHost.innerHTML = '';
        listHost.appendChild(el('div', { style: 'font-size:12px;color:var(--red)', text: errMsg(e) }));
      });
    }

    newBtn.addEventListener('click', function () { openCreateTemplateModal(reload); });
    syncBtn.addEventListener('click', function () {
      syncBtn.disabled = true;
      edge('template_sync', {}).then(function (res) {
        renderList((res && res.templates) || []);
        toast('Estado actualizado.', 'success');
      }).catch(function (e) { toast(errMsg(e), 'error'); }).then(function () { syncBtn.disabled = false; });
    });

    openModal('Plantillas de WhatsApp', body, [{ label: 'Cerrar', className: 'btn btn-primary btn-sm' }]);
    reload();
  }

  function openCreateTemplateModal(onDone) {
    var buttons = []; // [{type, text, url, phone}]
    var body = el('div', { style: 'display:flex;flex-direction:column;gap:10px;min-width:360px' });

    var name = el('input', { type: 'text', placeholder: 'ej. bienvenida_prospecto' });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Nombre (minúsculas, números y "_", sin espacios)' }), name));

    var category = el('select', {});
    [['MARKETING', 'Marketing'], ['UTILITY', 'Utility (transaccional)']].forEach(function (o) {
      category.appendChild(el('option', { value: o[0], text: o[1] }));
    });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Categoría' }), category));

    var language = el('select', {});
    TEMPLATE_LANGS.forEach(function (o) {
      language.appendChild(el('option', { value: o[0], text: o[1] }));
    });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Idioma' }), language));

    var headerText = el('input', { type: 'text', placeholder: 'Opcional — admite una variable {{1}}', maxlength: '60' });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Encabezado (opcional)' }), headerText));
    var headerExampleWrap = el('div');
    body.appendChild(headerExampleWrap);

    var bodyText = el('textarea', { rows: '4', placeholder: 'Hola {{1}}, …  Usa {{1}}, {{2}}… para variables.', maxlength: '1024' });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Cuerpo del mensaje' }), bodyText));
    var bodyExamplesWrap = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
    body.appendChild(bodyExamplesWrap);

    var footerText = el('input', { type: 'text', placeholder: 'Opcional, sin variables', maxlength: '60' });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Pie (opcional)' }), footerText));

    var buttonsWrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Botones (opcional, máx. 3)' }), buttonsWrap));
    var addBtnRow = el('button', { class: 'wai-chipbtn', text: '+ Añadir botón' });
    body.appendChild(addBtnRow);

    function renderButtons() {
      buttonsWrap.innerHTML = '';
      buttons.forEach(function (b, idx) {
        var typeSel = el('select', {});
        [['QUICK_REPLY', 'Respuesta rápida'], ['URL', 'Enlace'], ['PHONE_NUMBER', 'Llamar']].forEach(function (o) {
          typeSel.appendChild(el('option', { value: o[0], text: o[1] }));
        });
        typeSel.value = b.type || 'QUICK_REPLY';
        typeSel.addEventListener('change', function () { b.type = typeSel.value; renderButtons(); });

        var textIn = el('input', { type: 'text', placeholder: 'Texto del botón', maxlength: '25' });
        textIn.value = b.text || '';
        textIn.addEventListener('input', function () { b.text = textIn.value; });

        var row = el('div', { style: 'display:flex;gap:6px;align-items:center' }, typeSel, textIn);

        if (typeSel.value === 'URL') {
          var urlIn = el('input', { type: 'text', placeholder: 'https://…' });
          urlIn.value = b.url || '';
          urlIn.addEventListener('input', function () { b.url = urlIn.value; });
          row.appendChild(urlIn);
        } else if (typeSel.value === 'PHONE_NUMBER') {
          var phoneIn = el('input', { type: 'text', placeholder: 'Teléfono con código de país' });
          phoneIn.value = b.phone || '';
          phoneIn.addEventListener('input', function () { b.phone = phoneIn.value; });
          row.appendChild(phoneIn);
        }

        var rm = el('button', { class: 'wai-iconbtn', style: 'width:26px;height:26px;font-size:13px', text: '✕' });
        rm.addEventListener('click', function () { buttons.splice(idx, 1); renderButtons(); });
        row.appendChild(rm);

        buttonsWrap.appendChild(row);
      });
      addBtnRow.style.display = buttons.length >= 3 ? 'none' : '';
    }
    addBtnRow.addEventListener('click', function () { buttons.push({ type: 'QUICK_REPLY', text: '' }); renderButtons(); });
    renderButtons();

    function renderExamples() {
      headerExampleWrap.innerHTML = '';
      if (extractVarsClient(headerText.value).length) {
        var hIn = el('input', { type: 'text', placeholder: 'Valor de ejemplo para {{1}} del encabezado' });
        headerExampleWrap.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Ejemplo de la variable del encabezado' }), hIn));
      }
      bodyExamplesWrap.innerHTML = '';
      extractVarsClient(bodyText.value).forEach(function (n) {
        var bIn = el('input', { type: 'text', placeholder: 'Valor de ejemplo para {{' + n + '}}' });
        bodyExamplesWrap.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Ejemplo de {{' + n + '}}' }), bIn));
      });
    }
    headerText.addEventListener('input', renderExamples);
    bodyText.addEventListener('input', renderExamples);
    renderExamples();

    openModal('Nueva plantilla', body, [
      { label: 'Cancelar', className: 'btn btn-ghost btn-sm' },
      {
        label: 'Enviar a Meta para aprobación', className: 'btn btn-primary btn-sm',
        onClick: function (api) {
          if (!name.value.trim() || !bodyText.value.trim()) {
            toast('Completa al menos el nombre y el cuerpo del mensaje.', 'warn');
            return;
          }
          var headerEx = headerExampleWrap.querySelector('input');
          var bodyExInputs = Array.prototype.slice.call(bodyExamplesWrap.querySelectorAll('input'));
          var payload = {
            name: name.value.trim(),
            category: category.value,
            language: language.value,
            header_text: headerText.value.trim(),
            header_example: headerEx ? headerEx.value.trim() : '',
            body: bodyText.value.trim(),
            body_examples: bodyExInputs.map(function (i) { return i.value.trim(); }),
            footer_text: footerText.value.trim(),
            buttons: buttons.filter(function (b) { return b.text && b.text.trim(); }).map(function (b) {
              return { type: b.type, text: b.text.trim(), url: b.url, phone_number: b.phone };
            }),
          };
          api.setBusy(true);
          return edge('template_create', payload).then(function () {
            api.close();
            toast('Plantilla enviada a Meta. Revisa su estado en unos minutos con "Actualizar estado".', 'success');
            if (onDone) onDone();
          });
        },
      },
    ]);
  }

  // ── Seguimientos programados ─────────────────────────────────────────────
  function toLocalInputValue(d) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function openScheduleModal(prefill) {
    var conv = activeConv();
    if (!conv) return;
    var input = document.getElementById('wai-input');
    var body = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    var msg = el('textarea', { rows: '3', placeholder: 'Mensaje de seguimiento…' });
    msg.value = prefill != null ? prefill : ((input && input.value.trim()) || '');
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Mensaje' }), msg));

    var when = el('input', { type: 'datetime-local' });
    when.value = toLocalInputValue(new Date(Date.now() + 3600000));
    var quick = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
    [['En 1 hora', 3600], ['En 4 horas', 4 * 3600], ['Mañana 9:00', -1], ['En 3 días', 3 * 86400]].forEach(function (opt) {
      var b = el('button', { class: 'wai-chipbtn', text: opt[0] });
      b.addEventListener('click', function () {
        var d;
        if (opt[1] === -1) {
          d = new Date();
          d.setDate(d.getDate() + 1);
          d.setHours(9, 0, 0, 0);
        } else d = new Date(Date.now() + opt[1] * 1000);
        when.value = toLocalInputValue(d);
      });
      quick.appendChild(b);
    });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'Enviar el' }), quick, when));
    body.appendChild(el('div', { class: 'wai-hint', text: 'Ojo: si para esa fecha el contacto lleva más de 24 h sin escribirte, WhatsApp rechazará el mensaje libre y el seguimiento quedará marcado como fallido.' }));

    openModal('Programar seguimiento', body, [
      { label: 'Cancelar', className: 'btn btn-ghost btn-sm' },
      {
        label: 'Programar', className: 'btn btn-primary btn-sm',
        onClick: function (api) {
          var text = msg.value.trim();
          if (!text) { toast('Escribe el mensaje de seguimiento.', 'warn'); return; }
          var d = when.value ? new Date(when.value) : null;
          if (!d || isNaN(d.getTime()) || d.getTime() < Date.now() + 30000) {
            toast('Elige una fecha y hora futuras.', 'warn');
            return;
          }
          api.setBusy(true);
          return sb().from('whatsapp_followups').insert({
            user_id: state.uid,
            conversation_id: conv.id,
            body: text,
            send_at: d.toISOString(),
          }).then(function (r) {
            if (r.error) throw new Error(r.error.message);
            api.close();
            toast('Seguimiento programado para ' + fmtFull(d.toISOString()) + '.', 'success');
            if (input && msg.value === input.value) { input.value = ''; input.style.height = 'auto'; }
            loadFollowupsForActive();
            loadPendingFollowups();
          });
        },
      },
    ]);
  }

  function loadFollowupsForActive() {
    var convId = state.activeConvId;
    if (!convId) return;
    sb().from('whatsapp_followups')
      .select('*')
      .eq('conversation_id', convId)
      .order('send_at', { ascending: true })
      .limit(30)
      .then(function (r) {
        if (convId !== state.activeConvId) return;
        state.followups = r.data || [];
        renderDetail();
      });
  }

  function cancelFollowup(id) {
    sb().from('whatsapp_followups')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending')
      .then(function (r) {
        if (r.error) { toast(r.error.message, 'error'); return; }
        toast('Seguimiento cancelado.', 'info');
        loadFollowupsForActive();
        loadPendingFollowups();
      });
  }

  // ── Ficha del contacto (columna derecha) ─────────────────────────────────
  function loadDetail() {
    var conv = activeConv();
    state.member = null;
    if (conv && conv.member_id) {
      sb().from('prospect_list_members')
        .select('*')
        .eq('id', conv.member_id)
        .maybeSingle()
        .then(function (r) {
          if (!activeConv() || activeConv().member_id !== conv.member_id) return;
          state.member = r.data || null;
          if (state.member && state.member.list_id && !state.memberLists[state.member.list_id]) {
            sb().from('prospect_lists').select('id, name').eq('id', state.member.list_id).maybeSingle()
              .then(function (lr) {
                if (lr.data) state.memberLists[lr.data.id] = lr.data.name;
                renderDetail();
              });
          }
          renderDetail();
        });
    }
    loadFollowupsForActive();
  }

  function dRow(label, valueNode) {
    return el('div', { class: 'wai-d-row' },
      el('div', { class: 'wai-d-lbl', text: label }),
      typeof valueNode === 'string' ? el('div', { class: 'wai-d-val', text: valueNode }) : valueNode);
  }

  function renderDetail() {
    var host = document.getElementById('wai-detail');
    if (!host) return;
    host.classList.toggle('force', state.detailOpen);
    host.innerHTML = '';
    var conv = activeConv();
    if (!conv) {
      host.appendChild(el('div', { class: 'wai-empty' }, el('div', { class: 'empty-sub', text: 'La ficha del contacto aparece al abrir una conversación.' })));
      return;
    }
    var name = convName(conv);
    var m = state.member;

    var avatar = el('div', { class: 'wai-avatar', text: initialsOf(name) });
    avatar.setAttribute('style', avatarStyle(conv.wa_id) + ';width:52px;height:52px;font-size:18px;margin:0 auto');
    host.appendChild(el('div', { style: 'text-align:center;display:flex;flex-direction:column;gap:4px' },
      avatar,
      el('div', { style: 'font-size:14.5px;font-weight:650;color:var(--ink)', text: name }),
      el('div', { style: 'font-size:12px;color:var(--ink-3)', text: (m && [m.title, m.company].filter(Boolean).join(' · ')) || ('+' + conv.wa_id) })));

    var info = el('div', { class: 'wai-d-sec' }, el('div', { class: 'wai-d-title', text: 'Datos del contacto' }));
    info.appendChild(dRow('WhatsApp', '+' + conv.wa_id));
    if (m) {
      if (m.email) {
        var mail = el('div', { class: 'wai-d-val' });
        mail.appendChild(el('a', { href: sUrl('mailto:' + m.email), text: m.email }));
        if (m.email_status) mail.appendChild(el('span', { style: 'color:var(--ink-4);font-size:11px', text: ' (' + m.email_status + ')' }));
        info.appendChild(dRow('Email', mail));
      }
      if (m.linkedin_url) {
        var li = el('div', { class: 'wai-d-val' });
        li.appendChild(el('a', { href: sUrl(m.linkedin_url), target: '_blank', rel: 'noopener', text: 'Ver perfil de LinkedIn →' }));
        info.appendChild(dRow('LinkedIn', li));
      }
      if (m.title) info.appendChild(dRow('Cargo', m.title));
      if (m.company) {
        info.appendChild(dRow('Empresa', m.company + (m.company_domain ? ' · ' + m.company_domain : '')));
      }
      var loc = [m.city, m.state, m.country].filter(Boolean).join(', ');
      if (loc) info.appendChild(dRow('Ubicación', loc));
      if (m.list_id && state.memberLists[m.list_id]) info.appendChild(dRow('Lista', state.memberLists[m.list_id]));
      if (m.enriched_at) info.appendChild(dRow('Enriquecido', fmtFull(m.enriched_at)));
    } else if (conv.member_id) {
      info.appendChild(el('div', { class: 'wai-hint', text: 'Cargando datos del contacto…' }));
    } else {
      info.appendChild(el('div', { class: 'wai-hint', text: 'Este número no está vinculado a tus Listas de prospección.' }));
      var linkBtn = el('button', { class: 'btn btn-ghost btn-sm', style: 'align-self:flex-start', text: 'Vincular con un contacto' });
      linkBtn.addEventListener('click', openLinkMemberModal);
      info.appendChild(linkBtn);
    }
    host.appendChild(info);

    if (m && m.outreach && m.outreach.angle) {
      host.appendChild(el('div', { class: 'wai-d-sec' },
        el('div', { class: 'wai-d-title', text: 'Ángulo de outreach (IA)' }),
        el('div', { style: 'font-size:12.5px;color:var(--ink-2);line-height:1.55;white-space:pre-wrap', text: String(m.outreach.angle) })));
    }

    var fuSec = el('div', { class: 'wai-d-sec' });
    var fuHead = el('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
      el('div', { class: 'wai-d-title', text: 'Seguimientos' }));
    var addFu = el('button', { class: 'btn btn-ghost btn-sm', text: '+ Programar' });
    addFu.addEventListener('click', function () { openScheduleModal(''); });
    fuHead.appendChild(addFu);
    fuSec.appendChild(fuHead);
    if (!state.followups.length) {
      fuSec.appendChild(el('div', { class: 'wai-hint', text: 'Sin seguimientos programados. Programa un mensaje para que se envíe solo en X tiempo.' }));
    } else {
      state.followups.forEach(function (f) {
        var whenCls = f.status === 'failed' ? ' failed' : (f.status === 'sent' ? ' sent' : '');
        var label = { pending: 'Programado · ', processing: 'Enviando · ', sent: 'Enviado · ', failed: 'Falló · ', cancelled: 'Cancelado · ' }[f.status] || '';
        var item = el('div', { class: 'wai-fu-item' },
          el('div', { class: 'wai-fu-when' + whenCls, text: label + fmtFull(f.send_at) }),
          el('div', { class: 'wai-fu-body', text: f.body }));
        if (f.status === 'failed' && f.error_detail) {
          item.appendChild(el('div', { style: 'font-size:11px;color:var(--red)', text: f.error_detail }));
        }
        if (f.status === 'pending') {
          var cancel = el('button', { class: 'btn btn-ghost btn-sm', style: 'align-self:flex-start;color:var(--red)', text: 'Cancelar' });
          cancel.addEventListener('click', function () { cancelFollowup(f.id); });
          item.appendChild(cancel);
        }
        fuSec.appendChild(item);
      });
    }
    host.appendChild(fuSec);

    var danger = el('div', { class: 'wai-d-sec' });
    var del = el('button', { class: 'btn btn-ghost btn-sm', style: 'color:var(--red);align-self:flex-start', text: 'Eliminar conversación' });
    del.addEventListener('click', function () {
      if (!window.confirm('¿Eliminar esta conversación y todos sus mensajes de predictable.ai? (No borra nada en el teléfono del contacto.)')) return;
      sb().from('whatsapp_conversations').delete().eq('id', conv.id).then(function (r) {
        if (r.error) { toast(r.error.message, 'error'); return; }
        state.conversations = state.conversations.filter(function (c) { return c.id !== conv.id; });
        state.activeConvId = null;
        renderConvList();
        renderChat();
        renderDetail();
        refreshBadge();
      });
    });
    danger.appendChild(del);
    host.appendChild(danger);
  }

  // ── Vincular contacto / nueva conversación ───────────────────────────────
  function fetchPhoneMembers() {
    return sb().from('prospect_list_members')
      .select('id, name, first_name, last_name, title, company, phone, list_id')
      .not('phone', 'is', null)
      .order('name', { ascending: true })
      .limit(1000)
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return (r.data || []).filter(function (m) { return digitsOf(m.phone).length >= 8; });
      });
  }

  function memberPickList(onPick) {
    var box = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    var search = el('input', { class: 'wai-search', type: 'search', placeholder: 'Buscar por nombre, empresa…' });
    var listHost = el('div', { style: 'max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:2px' });
    listHost.innerHTML = window.Skeleton ? window.Skeleton.listRows(4, { avatar: true }) : 'Cargando…';
    box.appendChild(search);
    box.appendChild(listHost);

    var all = [];
    function paint() {
      var q = search.value.trim().toLowerCase();
      listHost.innerHTML = '';
      var rows = all.filter(function (m) {
        if (!q) return true;
        return ((m.name || '') + ' ' + (m.company || '') + ' ' + (m.title || '') + ' ' + (m.phone || '')).toLowerCase().indexOf(q) !== -1;
      }).slice(0, 80);
      if (!rows.length) {
        listHost.appendChild(el('div', { class: 'wai-hint', style: 'padding:10px', text: all.length ? 'Sin resultados.' : 'No hay contactos con teléfono en tus Listas. Enriquece teléfonos desde Prospección → Listas.' }));
        return;
      }
      rows.forEach(function (m) {
        var nm = m.name || [m.first_name, m.last_name].filter(Boolean).join(' ') || m.phone;
        var av = el('div', { class: 'wai-avatar', text: initialsOf(nm) });
        av.setAttribute('style', avatarStyle(m.phone) + ';width:32px;height:32px;font-size:11.5px');
        var item = el('div', { class: 'wai-pick-item' },
          av,
          el('div', { style: 'flex:1;min-width:0' },
            el('div', { style: 'font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: nm }),
            el('div', { style: 'font-size:11.5px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: [m.title, m.company].filter(Boolean).join(' · ') || m.phone })));
        item.addEventListener('click', function () { onPick(m); });
        listHost.appendChild(item);
      });
    }
    search.addEventListener('input', paint);
    fetchPhoneMembers().then(function (rows) { all = rows; paint(); })
      .catch(function (e) {
        listHost.innerHTML = '';
        listHost.appendChild(el('div', { style: 'font-size:12px;color:var(--red);padding:10px', text: errMsg(e) }));
      });
    return box;
  }

  function openNewConversationModal() {
    var body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    var modal;
    body.appendChild(el('div', { class: 'wai-hint', text: 'Elige un contacto de tus Listas (con teléfono enriquecido) o escribe un número directamente.' }));
    body.appendChild(memberPickList(function (m) {
      modal.setBusy(true);
      edge('start_conversation', { member_id: m.id }).then(function (res) {
        modal.close();
        onConversationStarted(res.conversation);
      }).catch(function (e) { modal.setBusy(false); toast(errMsg(e), 'error'); });
    }));
    var phoneIn = el('input', { type: 'tel', placeholder: '+52 1 55 1234 5678 (con código de país)' });
    var nameIn = el('input', { type: 'text', placeholder: 'Nombre (opcional)' });
    body.appendChild(el('div', { class: 'wai-field' }, el('label', { text: 'O número directo' }), phoneIn, nameIn));

    modal = openModal('Nueva conversación', body, [
      { label: 'Cancelar', className: 'btn btn-ghost btn-sm' },
      {
        label: 'Abrir chat', className: 'btn btn-primary btn-sm',
        onClick: function (api) {
          var d = digitsOf(phoneIn.value);
          if (d.length < 8) { toast('Escribe un número válido con código de país, o elige un contacto de la lista.', 'warn'); return; }
          api.setBusy(true);
          return edge('start_conversation', { phone: phoneIn.value, name: nameIn.value.trim() }).then(function (res) {
            api.close();
            onConversationStarted(res.conversation);
          });
        },
      },
    ]);
  }

  function onConversationStarted(conv) {
    if (!conv) return;
    var i = state.conversations.findIndex(function (c) { return c.id === conv.id; });
    if (i === -1) state.conversations.unshift(conv); else state.conversations[i] = conv;
    loadMemberNames().then(function () {
      selectConversation(conv.id);
    });
  }

  function openLinkMemberModal() {
    var conv = activeConv();
    if (!conv) return;
    var body = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    var modal;
    body.appendChild(el('div', { class: 'wai-hint', text: 'Vincula este número con un contacto de tus Listas para ver aquí su email, LinkedIn y todo lo enriquecido.' }));
    body.appendChild(memberPickList(function (m) {
      modal.setBusy(true);
      sb().from('whatsapp_conversations')
        .update({ member_id: m.id })
        .eq('id', conv.id)
        .then(function (r) {
          modal.setBusy(false);
          if (r.error) { toast(r.error.message, 'error'); return; }
          conv.member_id = m.id;
          delete state.memberNames[m.id];
          modal.close();
          loadMemberNames().then(function () {
            renderConvList();
            renderChat();
            loadDetail();
          });
        });
    }));
    modal = openModal('Vincular contacto', body, [{ label: 'Cerrar', className: 'btn btn-ghost btn-sm' }]);
  }

  // ── Realtime ─────────────────────────────────────────────────────────────
  function subscribeRealtime() {
    if (state.channel || !state.uid) return;
    try {
      state.channel = sb().channel('wa-inbox-' + state.uid)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'whatsapp_messages', filter: 'user_id=eq.' + state.uid },
          onMessageChange)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'whatsapp_conversations', filter: 'user_id=eq.' + state.uid },
          onConversationChange)
        .subscribe();
    } catch (e) {
      console.warn('[wa-inbox] realtime no disponible:', e);
    }
  }

  function unsubscribeRealtime() {
    if (!state.channel) return;
    try { sb().removeChannel(state.channel); } catch (e) { /* ignore */ }
    state.channel = null;
  }

  function inboxVisible() {
    var page = document.getElementById('page-wa-inbox');
    return !!(page && page.classList.contains('active')) && document.visibilityState === 'visible';
  }

  function onMessageChange(payload) {
    var row = payload && payload.new;
    if (!row || !row.id) return;
    if (row.conversation_id === state.activeConvId) {
      if (payload.eventType === 'INSERT') {
        appendMessage(row);
        renderWindowNote();
        if (row.direction === 'in' && inboxVisible()) {
          var c = activeConv();
          if (c) { c.unread_count = 0; }
          edge('mark_read', { conversation_id: row.conversation_id }).catch(function () {});
        }
      } else {
        patchMessageInPlace(row);
      }
    }
  }

  function onConversationChange(payload) {
    var row = payload && payload.new;
    if (payload && payload.eventType === 'DELETE') {
      var oldId = payload.old && payload.old.id;
      if (oldId) {
        state.conversations = state.conversations.filter(function (c) { return c.id !== oldId; });
        renderConvList();
        refreshBadge();
      }
      return;
    }
    if (!row || !row.id) return;
    var i = state.conversations.findIndex(function (c) { return c.id === row.id; });
    // Si estamos viendo esa conversación, el contador vuelve a 0 en el server.
    if (row.id === state.activeConvId && inboxVisible() && row.unread_count > 0) row.unread_count = 0;
    if (i === -1) state.conversations.unshift(row);
    else state.conversations[i] = row;
    sortConversations();
    loadMemberNames().then(renderConvList);
    refreshBadge();
  }

  // ── Badge del sidebar ────────────────────────────────────────────────────
  function refreshBadge() {
    var elB = document.getElementById('nav-wa-badge');
    if (!elB) return;
    var total = state.conversations.reduce(function (acc, c) { return acc + (c.unread_count || 0); }, 0);
    if (total > 0) {
      elB.textContent = total > 99 ? '99+' : String(total);
      elB.style.display = '';
    } else {
      elB.style.display = 'none';
    }
  }

  // ── API pública ──────────────────────────────────────────────────────────
  function openForMember(memberId, prefillText) {
    var navEl = document.querySelector('.nav-item[data-page="wa-inbox"]');
    if (typeof window.nav === 'function' && navEl) window.nav(navEl, 'wa-inbox');
    if (!state.built && !build()) return;
    getUid().then(function () {
      if (state.account === undefined) return loadAccount().then(function () { renderRoot(); });
    }).then(function () {
      if (!state.account) {
        show();
        toast('Primero conecta tu número de WhatsApp.', 'warn');
        return;
      }
      if (!document.getElementById('wai-convlist')) renderRoot();
      subscribeRealtime();
      return edge('start_conversation', { member_id: memberId }).then(function (res) {
        if (!state.conversations.length) {
          return new Promise(function (resolve) {
            sb().from('whatsapp_conversations').select('*')
              .order('last_message_at', { ascending: false, nullsFirst: false }).limit(300)
              .then(function (r) { state.conversations = r.data || []; resolve(res); });
          });
        }
        return res;
      }).then(function (res) {
        if (!res) return;
        onConversationStarted(res.conversation);
        if (prefillText) {
          setTimeout(function () {
            var input = document.getElementById('wai-input');
            if (input && !input.value) { input.value = prefillText; input.dispatchEvent(new Event('input')); input.focus(); }
          }, 250);
        }
      });
    }).catch(function (e) { toast(errMsg(e), 'error'); });
  }

  window.waInbox = {
    show: show,
    refreshBadge: refreshBadge,
    openForMember: openForMember,
  };

  // Badge al cargar la app (sin montar el inbox): una consulta ligera.
  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      try {
        sb().from('whatsapp_conversations').select('id, unread_count').gt('unread_count', 0)
          .then(function (r) {
            if (r.error || !r.data) return;
            if (!state.conversations.length) {
              var elB = document.getElementById('nav-wa-badge');
              if (!elB) return;
              var total = r.data.reduce(function (acc, c) { return acc + (c.unread_count || 0); }, 0);
              if (total > 0) { elB.textContent = total > 99 ? '99+' : String(total); elB.style.display = ''; }
            }
          });
      } catch (e) { /* supabase aún no está listo */ }
    }, 1200);
  });
})();
