// js/coach-live.js
// ═══════════════════════════════════════════════════════════
// AI Sales Coach en vivo — presentación compartida (2026-11-16).
//
// Dos piezas que usan los dos caminos del coach (js/realtime-coach.js =
// captura local, js/meeting-coach.js = el asistente entra a la reunión):
//
//  • CoachHUD  — ventana flotante siempre encima (Document Picture-in-Picture
//    de Chrome/Edge; ventana emergente como respaldo). Muestra la fase, qué
//    decir ahora, la orden del momento y las alertas SOBRE la reunión, para
//    que el vendedor no tenga que quedarse en la pestaña de Predictable.
//    Solo se puede abrir dentro de un clic del usuario (regla del navegador).
//
//  • CoachLive — la capa instantánea: pinta la guía de la fase desde el
//    segundo 0 (js/coach-playbook.js), muestra la respuesta base a una
//    objeción en cuanto el lead la dice (sin esperar al modelo), avisa si el
//    vendedor habla de más o se queda pegado en una fase, y recibe lo que
//    responde el modelo (también a medio escribir, en streaming).
//
// Nada de lo que pinta se inventa: las frases instantáneas son las plantillas
// del playbook; lo específico del lead lo trae el modelo. Todo texto entra al
// DOM con textContent (invariante de seguridad n.º 2).
// ═══════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  // Clave nueva (2026-11-16, tarde): la ventana flotante pasa a ser OPCIONAL y
  // apagada por defecto. El navegador del dueño (Arc) se cerraba solo mientras
  // la usaba; la pila del cierre muestra a Arc liberando un objeto interno al
  // pulsar un botón de su propia interfaz (p. ej. cerrar una ventana), no a
  // Predictable. Predictable ya no crea ventanas extra salvo que el usuario lo
  // pida, y nunca en Arc ni como ventana emergente.
  // Pedido del dueño (2026-11-16, noche): en Chrome y Edge la ventana vuelve a
  // abrirse SOLA al iniciar — quien comparte pantalla en la llamada no puede
  // volver a la pestaña de Predictable para leer al coach. Sigue apagable y
  // nunca se abre en Arc ni como ventana emergente.
  var LS_HUD = 'predictable_coach_hud_optin';
  function T(s) { return (global.i18n && global.i18n.t) ? global.i18n.t(s) : s; }
  function PB() { return global.CoachPlaybook || null; }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} }

  var ALERT_COLOR = { objection: '#f5a524', positive_signal: '#2bb673', risk: '#e15454', stage_guidance: '#7c9cff' };

  // ─── Estado que comparten la página y la ventana flotante ──────────────
  function blank() {
    return {
      live: false, status: '', timer: '00:00:00', prospect: '',
      stageId: '', stage: '', goal: '', doList: [],
      sayLabel: '', say: '', next: '', thinking: false,
      alerts: [], last: null,
      turn: '', warn: false, sayAt: 0,
      talk: { sdr: 0, lead: 0 },
    };
  }
  var state = blank();

  // ═══ CoachHUD ═════════════════════════════════════════════════════════
  var hudWin = null;      // Window de la ventana flotante

  // Liquid Glass (2026-11-25): la ventana vive sobre la reunión, así que el
  // vidrio se arma con su propia malla de color detrás y tarjetas translúcidas
  // con borde especular. Colores de marca, sin depender del tema de la app.
  var HUD_CSS = [
    '*{box-sizing:border-box}',
    // La ventana NO se desplaza: cabecera, última frase y botones quedan fijos y
    // solo la zona central (.body) hace scroll.
    'html,body{margin:0;height:100%;overflow:hidden;overscroll-behavior:none}',
    'body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#eef2fb;display:flex;flex-direction:column;height:100vh;font-size:13px;line-height:1.45;',
      'background:radial-gradient(120% 70% at 0% 0%,rgba(47,102,255,.42),transparent 60%),radial-gradient(90% 60% at 100% 12%,rgba(6,182,212,.30),transparent 62%),radial-gradient(110% 70% at 50% 110%,rgba(43,182,115,.24),transparent 60%),#070b16}',
    '.glass{background:linear-gradient(180deg,rgba(255,255,255,.11),rgba(255,255,255,.05));border:1px solid rgba(255,255,255,.16);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 30px -18px rgba(0,0,0,.8);-webkit-backdrop-filter:blur(22px) saturate(1.6);backdrop-filter:blur(22px) saturate(1.6);border-radius:16px}',
    '.top{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;flex-shrink:0}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#2bb673;box-shadow:0 0 10px rgba(43,182,115,.9);flex-shrink:0}',
    '.dot.off{background:#5b6478;box-shadow:none}',
    '.dot.warn{background:#f5a524;box-shadow:0 0 10px rgba(245,165,36,.8)}',
    '.st{font-weight:600;font-size:12px;color:#c5cde0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}',
    '.turn{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);color:#dbe3f5;white-space:nowrap}',
    '.turn.you{background:rgba(43,182,115,.22);border-color:rgba(43,182,115,.6);color:#8ff0bd}',
    '.turn.lead{background:rgba(6,182,212,.2);border-color:rgba(6,182,212,.55);color:#9be9f7}',
    '.turn:empty{display:none}',
    '.tm{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#9aa5bd}',
    '.steps{display:flex;gap:4px;padding:0 12px 8px;flex-shrink:0}',
    '.steps i{flex:1;height:4px;border-radius:99px;background:rgba(255,255,255,.14);transition:background .3s}',
    '.steps i.done{background:rgba(124,156,255,.55)}',
    '.steps i.on{background:linear-gradient(90deg,#2f66ff,#06b6d4)}',
    '.body{flex:1 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 12px 12px;display:flex;flex-direction:column;gap:10px}',
    '.body>*{flex-shrink:0}',
    '.lbl{font-size:11px;font-weight:600;color:#9aa5bd;margin-bottom:4px}',
    '.stage{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
    '.stage b{font-size:15px;color:#fff}',
    '.goal{font-size:12px;color:#b4bdd2;margin-top:2px}',
    '.say{padding:14px;border-color:rgba(124,156,255,.6);background:linear-gradient(135deg,rgba(47,102,255,.34),rgba(6,182,212,.2))}',
    '.say .lbl{color:#cfdcff}',
    '.say .txt{font-size:17px;font-weight:650;color:#fff;line-height:1.4;letter-spacing:-.01em}',
    '.say.think .txt{opacity:.8}',
    '.say.fresh{animation:fresh .9s ease-out}',
    '@keyframes fresh{0%{box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 0 0 3px rgba(124,156,255,.75)}100%{box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 0 0 0 rgba(124,156,255,0)}}',
    '.next{padding:10px 12px}',
    '.next ul{margin:0;padding-left:16px}',
    '.next li{margin:2px 0}',
    '.al{padding:10px 12px;border-left-width:3px}',
    '.al .t{font-size:12px;font-weight:700;margin-bottom:3px}',
    '.al .e{font-size:12px;color:#c9d1e2}',
    '.al .p{font-size:13.5px;font-weight:600;color:#fff;margin-top:6px}',
    '.last{font-size:11.5px;color:#9aa5bd;border-top:1px solid rgba(255,255,255,.1);padding:8px 12px;flex-shrink:0;max-height:54px;overflow:hidden}',
    '.last b{color:#c5cde0}',
    '.foot{display:flex;gap:8px;padding:8px 12px 10px;flex-shrink:0}',
    'button{font:inherit;font-size:12px;font-weight:600;border-radius:999px;padding:8px 12px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.18);color:#eef2fb;cursor:pointer;flex:1}',
    'button:hover{background:rgba(255,255,255,.14)}',
    'button:focus-visible{outline:2px solid #7c9cff;outline-offset:2px}',
    'button.end{color:#ffa0a0;border-color:rgba(225,84,84,.5)}',
    '.pulse{animation:p 1.2s ease-in-out infinite}',
    '@keyframes p{50%{opacity:.45}}',
    '@media (prefers-reduced-motion:reduce){.pulse,.say.fresh{animation:none}.steps i{transition:none}}',
  ].join('');

  // Arc (Chromium) anuncia Document Picture-in-Picture pero su gestor de
  // ventanas no lo implementa bien: el dueño reportó (2026-11-16) que Arc se
  // cierra solo (EXC_BAD_ACCESS en el hilo principal) al usar el coach. Arc no
  // se identifica en el user agent; sí inyecta sus variables de tema
  // (--arc-palette-*) en la página. En Arc se usa la ventana emergente normal.
  function isArc() {
    try {
      var cs = getComputedStyle(document.documentElement);
      return !!(cs.getPropertyValue('--arc-palette-title') || cs.getPropertyValue('--arc-palette-background')).trim();
    } catch (e) { return false; }
  }
  // En Arc la ventana es OPCIONAL y apagada por defecto (decisión del dueño,
  // 2026-11-16, noche): el usuario la enciende sabiendo el riesgo de cierre, con
  // su propia preferencia, y sin la reapertura automática al cambiar de pestaña.
  var LS_HUD_ARC = 'predictable_coach_hud_arc';
  function hudSupported() { return 'documentPictureInPicture' in global; }
  function hudPref() {
    if (!hudSupported()) return false;
    return isArc() ? lsGet(LS_HUD_ARC, false) : lsGet(LS_HUD, true);
  }
  function hudSetPref(on) { lsSet(isArc() ? LS_HUD_ARC : LS_HUD, !!on); }
  function hudIsOpen() { return !!(hudWin && !hudWin.closed); }

  function hudBuild(win) {
    var d = win.document;
    d.title = 'AI Sales Coach';
    var st = d.createElement('style');
    st.textContent = HUD_CSS;
    d.head.appendChild(st);
    d.body.textContent = '';
    function el(tag, cls, id) {
      var n = d.createElement(tag);
      if (cls) n.className = cls;
      if (id) n.id = id;
      return n;
    }
    var top = el('div', 'top');
    top.appendChild(el('span', 'dot', 'h-dot'));
    top.appendChild(el('span', 'st', 'h-status'));
    top.appendChild(el('span', 'turn', 'h-turn'));
    top.appendChild(el('span', 'tm', 'h-timer'));
    // Las seis fases de la llamada: dónde vas y cuánto falta.
    var steps = el('div', 'steps', 'h-steps');
    ((PB() && PB().STAGES) || []).forEach(function (s) { var i = el('i'); i.setAttribute('data-stage', s.id); steps.appendChild(i); });
    var body = el('div', 'body');
    var stageBox = el('div');
    var stageLbl = el('div', 'lbl'); stageLbl.id = 'h-stage-lbl';
    var stageRow = el('div', 'stage'); stageRow.appendChild(el('b', '', 'h-stage'));
    stageBox.appendChild(stageLbl); stageBox.appendChild(stageRow); stageBox.appendChild(el('div', 'goal', 'h-goal'));
    var say = el('div', 'say glass', 'h-say-box');
    say.appendChild(el('div', 'lbl', 'h-say-lbl'));
    say.appendChild(el('div', 'txt', 'h-say'));
    var next = el('div', 'next glass', 'h-next-box');
    next.appendChild(el('div', 'lbl', 'h-next-lbl'));
    next.appendChild(el('div', '', 'h-next'));
    body.appendChild(stageBox); body.appendChild(say); body.appendChild(next);
    body.appendChild(el('div', '', 'h-alerts'));
    var foot = el('div', 'foot');
    var back = el('button'); back.id = 'h-back';
    back.addEventListener('click', function () { try { global.focus(); } catch (e) {} });
    var end = el('button', 'end'); end.id = 'h-end';
    end.addEventListener('click', function () {
      if (typeof global.endCoachSession === 'function') global.endCoachSession();
    });
    foot.appendChild(back); foot.appendChild(end);
    d.body.appendChild(top); d.body.appendChild(steps); d.body.appendChild(body);
    d.body.appendChild(el('div', 'last', 'h-last'));
    d.body.appendChild(foot);
  }

  function hudRender() {
    if (!hudIsOpen()) return;
    var d = hudWin.document;
    function set(id, text) { var n = d.getElementById(id); if (n) n.textContent = text == null ? '' : String(text); return n; }
    var dot = d.getElementById('h-dot');
    if (dot) dot.className = 'dot' + (!state.live ? ' off' : state.warn ? ' warn' : '');
    var turn = d.getElementById('h-turn');
    if (turn) { turn.textContent = state.live ? turnLabel() : ''; turn.className = 'turn' + (state.turn === 'you' ? ' you' : state.turn === 'lead' ? ' lead' : ''); }
    var steps = d.getElementById('h-steps');
    if (steps) paintSteps(steps.children);
    set('h-status', state.status ? T(state.status) : (state.live ? T('Escuchando') : T('Sin sesión activa')));
    set('h-timer', state.live ? state.timer : '');
    set('h-stage-lbl', T('Fase') + (state.prospect ? ' · ' + state.prospect : ''));
    set('h-stage', state.stage || '—');
    set('h-goal', state.goal || '');
    var sayBox = d.getElementById('h-say-box');
    if (sayBox) {
      sayBox.style.display = state.say ? '' : 'none';
      var fresh = state.sayAt && Date.now() - state.sayAt < 900;
      sayBox.className = 'say glass' + (state.thinking ? ' think' : '') + (fresh ? ' fresh' : '');
    }
    set('h-say-lbl', T(state.sayLabel || 'Di esto ahora'));
    set('h-say', state.say);
    var nextBox = d.getElementById('h-next-box');
    var nextEl = d.getElementById('h-next');
    if (nextBox && nextEl) {
      nextEl.textContent = '';
      if (state.next) {
        nextEl.textContent = state.next;
      } else if (state.doList && state.doList.length) {
        var ul = d.createElement('ul');
        state.doList.forEach(function (x) { var li = d.createElement('li'); li.textContent = x; ul.appendChild(li); });
        nextEl.appendChild(ul);
      }
      nextBox.style.display = (state.next || (state.doList && state.doList.length)) ? '' : 'none';
    }
    var lbl = set('h-next-lbl', state.thinking ? T('Analizando…') : T('Qué hacer ahora'));
    if (lbl) lbl.className = 'lbl' + (state.thinking ? ' pulse' : '');
    var al = d.getElementById('h-alerts');
    if (al) {
      al.textContent = '';
      al.style.cssText = 'display:flex;flex-direction:column;gap:8px';
      state.alerts.slice(0, 2).forEach(function (a) {
        var c = ALERT_COLOR[a.type] || '#22c3d6';
        var box = d.createElement('div'); box.className = 'al glass'; box.style.borderLeftColor = c;
        var t = d.createElement('div'); t.className = 't'; t.style.color = c; t.textContent = a.title || '';
        box.appendChild(t);
        if (a.explanation) { var e = d.createElement('div'); e.className = 'e'; e.textContent = a.explanation; box.appendChild(e); }
        if (a.suggested_phrase) { var p = d.createElement('div'); p.className = 'p'; p.textContent = a.suggested_phrase; box.appendChild(p); }
        al.appendChild(box);
      });
    }
    var last = d.getElementById('h-last');
    if (last) {
      last.textContent = '';
      if (state.last && state.last.text) {
        var b = d.createElement('b'); b.textContent = state.last.speaker + ': ';
        last.appendChild(b);
        last.appendChild(d.createTextNode(state.last.text.slice(-160)));
      } else {
        last.textContent = state.live ? T('Esperando audio…') : '';
      }
    }
    set('h-back', T('Abrir Predictable'));
    var endBtn = set('h-end', T('Finalizar sesión'));
    if (endBtn) endBtn.style.display = state.live ? '' : 'none';
  }

  /**
   * Abre la ventana flotante. Hay que llamarla DENTRO de un clic: el navegador
   * rechaza la petición sin un gesto reciente del usuario. Devuelve true si
   * quedó abierta.
   */
  async function hudOpen() {
    if (hudIsOpen()) { hudRender(); return true; }
    try {
      // Sin ventana emergente de respaldo: sin Document Picture-in-Picture no hay ventana.
      if (!hudSupported()) return false;
      hudWin = await global.documentPictureInPicture.requestWindow({ width: 380, height: 560 });
    } catch (e) {
      console.warn('[CoachHUD] no se pudo abrir la ventana flotante:', e && e.message);
      hudWin = null;
      return false;
    }
    hudBuild(hudWin);
    hudWin.addEventListener('pagehide', function () { hudWin = null; paintHudButton(); });
    hudRender();
    paintHudButton();
    return true;
  }
  function hudClose() {
    if (hudIsOpen()) { try { hudWin.close(); } catch (e) {} }
    hudWin = null;
    paintHudButton();
  }
  function paintHudButton() {
    var b = document.getElementById('mc-hud-btn');
    if (!b) return;
    b.style.display = hudSupported() ? '' : 'none';
    var open = hudIsOpen();
    b.textContent = open ? 'Cerrar ventana flotante' : 'Abrir ventana flotante';
    // Cerrada durante una sesión viva = botón destacado, para reabrirla en un clic.
    b.className = 'btn btn-sm ' + (!open && state.live ? 'btn-jade' : 'btn-ghost');
  }

  // Chrome 134+ abre solo la ventana flotante al cambiar de pestaña o de app si
  // la página usa la cámara, el micrófono o comparte pantalla (PiP automático
  // de apps web). Si el navegador no lo soporta, esto no hace nada.
  var autoPipOn = false;
  function setAutoPip(on) {
    if (!hudSupported() || isArc() || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', on ? function () {
        if (state.live && hudPref() && !hudIsOpen()) hudOpen();
      } : null);
      autoPipOn = on;
    } catch (e) { /* acción no soportada en este navegador */ }
  }
  function hudToggle() { if (hudIsOpen()) hudClose(); else hudOpen(); }

  // ═══ CoachLive ════════════════════════════════════════════════════════
  var startedAt = 0;
  var ticker = null;
  var turnTicker = null;
  var modelSpoke = false;        // el modelo ya dio una orden: manda sobre la plantilla
  var instantSeen = {};          // id de alerta instantánea → ts
  var nudgedStage = {};          // fase por la que ya se avisó el exceso de tiempo
  var words = { sdr: 0, lead: 0, lastNudge: 0 };
  var INSTANT_TTL_MS = 240000;
  var MAX_ALERT_CARDS = 6;

  // ─── Ritmo de la conversación (2026-11-25) ─────────────────────────────
  // El vendedor lee mientras habla con una persona: una frase que cambia a
  // media lectura marea más de lo que ayuda. Reglas, iguales para los dos
  // caminos del coach:
  //  • una frase nueva se queda en pantalla lo que toma leerla (dwell);
  //  • mientras el vendedor habla no se le cambia (la está diciendo);
  //  • si el lead ya dijo algo nuevo, la frase vieja caducó: entra la nueva ya;
  //  • una objeción reconocida entra de inmediato (prioridad).
  // Lo que llega antes de tiempo espera en `gate.queued` (gana lo último).
  var lastLeadAt = 0, lastSdrAt = 0;
  var gate = { minUntil: 0, queued: null, queuedAt: 0, timer: null, stream: null, leadWordsAtSay: 0, leadWords: 0 };
  var HOLD_MAX_MS = 6000;
  function dwellFor(text) { return Math.max(2200, Math.min(6500, 1000 + String(text || '').length * 40)); }
  function sellerSpeaking() { return Date.now() - lastSdrAt < 900; }
  function leadSpeaking() { return Date.now() - lastLeadAt < 1100; }
  function gateOpen() {
    var now = Date.now();
    if (sellerSpeaking()) return false;
    // El lead ya respondió a lo que había en pantalla: no hay nada que proteger.
    if (gate.leadWords - gate.leadWordsAtSay >= 6) return now - state.sayAt >= 1200;
    return now >= gate.minUntil;
  }
  function applySay(say, next, label) {
    var changed = say && say !== state.say;
    if (say) { state.say = say; state.sayLabel = label || 'Di esto ahora'; }
    if (next != null) state.next = next;
    if (changed) {
      state.sayAt = Date.now();
      gate.minUntil = state.sayAt + dwellFor(say);
      gate.leadWordsAtSay = gate.leadWords;
    }
  }
  function clearQueue() {
    if (gate.timer) { clearTimeout(gate.timer); gate.timer = null; }
    gate.queued = null; gate.queuedAt = 0;
  }
  function flushQueue() {
    gate.timer = null;
    if (!gate.queued || !state.live) { clearQueue(); return; }
    if (gateOpen() || Date.now() - gate.queuedAt >= HOLD_MAX_MS) {
      var q = gate.queued; clearQueue();
      applySay(q.say, q.next);
      paint();
      return;
    }
    gate.timer = setTimeout(flushQueue, 300);
  }
  /** Ofrece una frase: entra ya si se puede; si no, espera su turno. */
  function offerSay(say, next, priority) {
    if (!say && !next) return;
    if (!say || say === state.say) { clearQueue(); applySay('', next || state.next); return; }
    if (priority || !state.say || gateOpen()) { clearQueue(); applySay(say, next || ''); return; }
    if (!gate.queued) gate.queuedAt = Date.now();
    gate.queued = { say: say, next: next || '' };
    if (!gate.timer) gate.timer = setTimeout(flushQueue, 300);
  }

  function turnLabel() {
    return state.turn === 'lead' ? T('Habla el lead · escucha')
      : state.turn === 'sdr' ? T('Hablas tú')
      : state.turn === 'you' ? T('Tu turno') : '';
  }
  function computeTurn() {
    if (!state.live) return '';
    if (leadSpeaking()) return 'lead';
    if (Date.now() - lastSdrAt < 1100) return 'sdr';
    if (lastLeadAt && lastLeadAt > lastSdrAt) return 'you';
    return '';
  }
  function tickTurn() {
    var t = computeTurn();
    if (t === state.turn) return;
    state.turn = t;
    paintTurn();
    if (hudIsOpen()) hudRender();
  }

  function paintSteps(nodes) {
    var pb = PB();
    var ids = ((pb && pb.STAGES) || []).map(function (x) { return x.id; });
    var cur = ids.indexOf(state.stageId);
    Array.prototype.forEach.call(nodes || [], function (n) {
      var i = ids.indexOf(n.getAttribute('data-stage'));
      var cls = (n.getAttribute('data-base') || '');
      n.className = (cls + (i === cur ? ' on' : (cur >= 0 && i < cur) ? ' done' : '')).trim();
      if (i === cur) n.setAttribute('aria-current', 'step'); else n.removeAttribute('aria-current');
    });
  }
  function buildPageSteps() {
    var host = document.getElementById('mc-steps');
    var pb = PB();
    if (!host || !pb || host.childElementCount) return;
    pb.STAGES.forEach(function (s, i) {
      var li = document.createElement('li');
      li.setAttribute('data-stage', s.id);
      li.setAttribute('data-base', 'mc-step');
      li.className = 'mc-step';
      var n = document.createElement('span'); n.className = 'mc-step-n notranslate'; n.textContent = String(i + 1);
      var t = document.createElement('span'); t.className = 'mc-step-t'; t.textContent = s.label;
      li.appendChild(n); li.appendChild(t);
      host.appendChild(li);
    });
  }
  function paintTurn() {
    var el = document.getElementById('mc-turn');
    if (!el) return;
    var label = state.live ? turnLabel() : '';
    el.textContent = label;
    el.style.display = label ? '' : 'none';
    el.className = 'mc-turn' + (state.turn === 'you' ? ' is-you' : state.turn === 'lead' ? ' is-lead' : '');
  }
  function paintTalk() {
    var box = document.getElementById('mc-talk');
    if (!box) return;
    var total = state.talk.sdr + state.talk.lead;
    var pct = total >= 30 ? Math.round(state.talk.sdr * 100 / total) : null;
    var num = document.getElementById('mc-talk-num');
    var fill = document.getElementById('mc-talk-fill');
    var hint = document.getElementById('mc-talk-hint');
    if (num) num.textContent = pct == null ? '—' : pct + '% / ' + (100 - pct) + '%';
    if (fill) { fill.style.width = (pct == null ? 0 : pct) + '%'; fill.className = 'mc-talk-fill' + (pct != null && pct > 65 ? ' is-high' : ''); }
    if (hint) hint.textContent = pct == null ? T('Se calcula cuando hay conversación suficiente.')
      : pct > 65 ? T('Estás hablando de más: pregunta y escucha.')
      : T('Buen balance: quien pregunta controla la llamada.');
  }

  function paintPage() {
    buildPageSteps();
    var steps = document.getElementById('mc-steps');
    if (steps) paintSteps(steps.children);
    var st = document.getElementById('mc-stage');
    if (st) st.textContent = state.stage || '—';
    var goal = document.getElementById('mc-stage-goal');
    if (goal) goal.textContent = state.goal || '';
    var sayBox = document.getElementById('mc-say-box');
    var sayLbl = document.getElementById('mc-say-label');
    var say = document.getElementById('mc-say');
    if (sayBox) {
      sayBox.style.display = state.say ? '' : 'none';
      var fresh = state.sayAt && Date.now() - state.sayAt < 900;
      sayBox.classList.toggle('is-fresh', !!fresh);
      sayBox.classList.toggle('is-thinking', !!state.thinking);
    }
    if (sayLbl) sayLbl.textContent = T(state.sayLabel || 'Di esto ahora');
    if (say) say.textContent = state.say || '';
    var think = document.getElementById('mc-thinking-chip');
    if (think) think.style.display = state.thinking ? '' : 'none';
    var ns = document.getElementById('mc-next-steps');
    if (ns) {
      ns.textContent = '';
      var items = state.next ? [state.next] : (state.doList || []);
      items.forEach(function (x) {
        var div = document.createElement('div');
        div.className = 'mc-next-item';
        div.textContent = x;
        ns.appendChild(div);
      });
    }
    paintTurn();
    paintTalk();
  }
  function paint() { paintPage(); hudRender(); }

  function applyStage(id, keepModelText) {
    var pb = PB();
    var s = pb && pb.stage(id);
    if (!s) return;
    var changed = state.stageId !== id;
    state.stageId = id;
    // Las plantillas del playbook se traducen aquí (página y ventana flotante
    // muestran lo mismo); lo que escribe el modelo ya llega en el idioma del usuario.
    state.stage = T(s.label);
    state.goal = T(s.goal);
    state.doList = s.do.map(T);
    if (changed && !keepModelText) {
      clearQueue();
      applySay(T(s.say), '');
    }
  }

  /** Arranca la sesión: fase de apertura y qué decir, antes de que nadie hable. */
  function begin(prospect, opts) {
    clearQueue();
    state = blank();
    state.live = true;
    state.status = (opts && opts.status) || 'Conectando…';
    state.prospect = (prospect && prospect.name) || '';
    startedAt = Date.now();
    modelSpoke = false; instantSeen = {}; nudgedStage = {};
    words = { sdr: 0, lead: 0, lastNudge: 0 };
    lastLeadAt = 0; lastSdrAt = 0;
    gate = { minUntil: 0, queued: null, queuedAt: 0, timer: null, stream: null, leadWordsAtSay: 0, leadWords: 0 };
    applyStage('rapport');
    if (ticker) clearInterval(ticker);
    ticker = setInterval(watch, 20000);
    if (turnTicker) clearInterval(turnTicker);
    turnTicker = setInterval(tickTurn, 400);
    paint();
    paintHudButton();
    setAutoPip(true);
  }

  function end() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (turnTicker) { clearInterval(turnTicker); turnTicker = null; }
    clearQueue();
    if (autoPipOn) setAutoPip(false);
    state.live = false; state.thinking = false; state.turn = ''; state.warn = false;
    state.status = 'Sesión finalizada';
    paintTurn();
    hudRender();
    // La ventana flotante solo tiene sentido con la sesión viva.
    setTimeout(function () { if (!state.live) hudClose(); }, 2500);
  }

  /** `warn` = algo pide atención (reconectando, sin audio): el punto pasa a ámbar. */
  function status(text, warn) { state.status = text || ''; state.warn = !!warn; hudRender(); }
  function timer(text) { state.timer = text || ''; if (hudIsOpen()) { var n = hudWin.document.getElementById('h-timer'); if (n) n.textContent = state.timer; } }
  function thinking(on) {
    if (state.thinking === !!on) return;
    state.thinking = !!on; paint();
  }

  /**
   * Texto parcial de la frase a decir, mientras el modelo todavía escribe.
   * `streamId` identifica la respuesta: solo se pinta a medio escribir si al
   * empezar la frase anterior ya se podía reemplazar; si no, esa respuesta
   * espera completa en la cola (nunca se cambia una frase a media lectura).
   */
  function partial(sayText, streamId) {
    if (!sayText) return;
    if (gate.stream !== streamId) {
      if (!(gateOpen() || !state.say)) return;
      gate.stream = streamId;
      clearQueue();
    }
    state.thinking = true;
    applySay(sayText, '');
    paint();
  }

  /**
   * Respuesta del modelo. La fase y las alertas entran de inmediato; la frase
   * y la orden pasan por el ritmo de la conversación (offerSay).
   */
  function coach(out, streamId) {
    out = out || {};
    state.thinking = false;
    if (out.stage) applyStage(String(out.stage).toLowerCase(), true);
    var say = String(out.say_now || '').trim();
    var next = String(out.next_step || '').trim();
    if (!say && Array.isArray(out.alerts)) {
      for (var i = 0; i < out.alerts.length; i++) {
        if (out.alerts[i] && out.alerts[i].suggested_phrase) { say = String(out.alerts[i].suggested_phrase); break; }
      }
    }
    if (say || next) modelSpoke = true;
    // La respuesta que ya se venía pintando en streaming termina en su sitio.
    var streaming = streamId != null && gate.stream === streamId;
    gate.stream = null;
    if (streaming) { clearQueue(); applySay(say, next); }
    else offerSay(say, next, false);
    (Array.isArray(out.alerts) ? out.alerts : []).forEach(function (a) { pushAlert(a); });
    paint();
  }

  function pushAlert(a) {
    if (!a || typeof a !== 'object') return;
    state.alerts.unshift(a);
    if (state.alerts.length > 4) state.alerts.length = 4;
  }

  var ALERT_KIND = { objection: 'Objeción', positive_signal: 'Señal de compra', risk: 'Riesgo', stage_guidance: 'Cambio de fase' };
  function alertCard(a) {
    var type = ALERT_KIND[a.type] ? a.type : 'stage_guidance';
    var card = document.createElement('div');
    card.className = 'ai-alert-dynamic mc-alert mc-alert--' + type;
    var kind = document.createElement('div'); kind.className = 'mc-alert-kind'; kind.textContent = T(ALERT_KIND[type]);
    card.appendChild(kind);
    var tag = document.createElement('div'); tag.className = 'mc-alert-title notranslate'; tag.textContent = a.title || '';
    card.appendChild(tag);
    if (a.explanation) { var tx = document.createElement('div'); tx.className = 'mc-alert-text notranslate'; tx.textContent = a.explanation; card.appendChild(tx); }
    if (a.suggested_phrase) {
      var box = document.createElement('div'); box.className = 'mc-alert-say';
      var strong = document.createElement('span'); strong.className = 'mc-alert-say-k'; strong.textContent = T('Di esto:');
      var ph = document.createElement('span'); ph.className = 'notranslate'; ph.textContent = a.suggested_phrase;
      box.appendChild(strong); box.appendChild(ph);
      card.appendChild(box);
    }
    return card;
  }
  /** Agrega la tarjeta a la página y recorta las más viejas (la lista no crece sin fin). */
  function showAlert(a) {
    var events = document.getElementById('mc-events');
    if (!events || !a || typeof a !== 'object') return;
    events.prepend(alertCard(a));
    var cards = events.querySelectorAll('.mc-alert');
    for (var i = MAX_ALERT_CARDS; i < cards.length; i++) cards[i].remove();
    var empty = document.getElementById('mc-events-empty');
    if (empty) empty.style.display = 'none';
  }

  /** Alerta determinista (playbook): se pinta al instante, una vez por tema. */
  function instant(key, a, priority) {
    var now = Date.now();
    if (instantSeen[key] && now - instantSeen[key] < INSTANT_TTL_MS) return null;
    instantSeen[key] = now;
    a.instant = true;
    pushAlert(a);
    showAlert(a);
    // Mientras el modelo arma la respuesta a la medida, la plantilla es lo que
    // el vendedor puede decir YA. Una objeción entra sin esperar turno.
    if (a.suggested_phrase) offerSay(a.suggested_phrase, '', !!priority);
    paint();
    return a;
  }

  /** Subtítulo en vivo de la página: lo último que se dijo (o el aviso de espera). */
  function caption(label, speaker, text, dim) {
    var k = document.getElementById('mc-caption-k');
    var who = document.getElementById('mc-caption-who');
    var t = document.getElementById('mc-caption-t');
    if (k) k.textContent = label || '';
    if (who) { who.textContent = speaker ? speaker + ':' : ''; who.className = 'mc-caption-who notranslate' + (speaker === 'SDR' ? ' is-sdr' : ''); }
    // Lo que dijo una persona no se traduce; el aviso de espera (sin hablante) sí.
    if (t) { t.textContent = speaker ? (text || '') : T(text || ''); t.className = 'mc-caption-t notranslate' + (dim ? ' is-dim' : ''); }
  }

  /**
   * Algo se dijo. `isLead` = lo dijo el prospecto. Con un resultado final del
   * lead se busca una objeción conocida y se responde sin esperar al modelo.
   */
  function heard(speaker, text, isFinal, isLead) {
    state.last = { speaker: speaker, text: text };
    if (isLead) lastLeadAt = Date.now(); else lastSdrAt = Date.now();
    caption(isFinal ? 'Lo último que se dijo' : 'Escuchando…', speaker, text, !isFinal);
    if (isFinal) {
      var n = String(text || '').split(/\s+/).filter(Boolean).length;
      if (isLead) { words.lead += n; state.talk.lead += n; gate.leadWords += n; }
      else { words.sdr += n; state.talk.sdr += n; }
      paintTalk();
      if (isLead && PB()) {
        var o = PB().detectObjection(text);
        if (o) {
          if (state.stageId !== 'close') applyStage('negotiation', true);
          instant('obj:' + o.id, { type: 'objection', title: T(o.title), explanation: T(o.why), suggested_phrase: T(o.say) }, true);
          return;
        }
      }
    }
    tickTurn();
    hudRender();
  }

  // Vigilancia sin IA, cada 20 s: fase que se alarga y vendedor que habla de más.
  function watch() {
    if (!state.live) return;
    var pb = PB();
    var min = (Date.now() - startedAt) / 60000;
    if (pb && state.stageId && state.stageId !== 'close' && !nudgedStage[state.stageId]) {
      var nx = pb.nextStage(state.stageId);
      // Solo avisa si el modelo no movió la fase y ya pasó su tiempo + 1 min.
      if (nx && min > pb.stageDeadline(state.stageId) + 1 && (words.sdr + words.lead) > 40) {
        nudgedStage[state.stageId] = true;
        instant('stage:' + state.stageId, {
          type: 'stage_guidance',
          title: T('Hora de pasar a: {0}').replace('{0}', T(nx.label)),
          explanation: T(nx.goal),
          suggested_phrase: T(nx.say),
        });
      }
    }
    var total = words.sdr + words.lead;
    if (total >= 150 && words.sdr / total > 0.65 && Date.now() - words.lastNudge > 180000) {
      words.lastNudge = Date.now();
      instantSeen['talk'] = 0;
      instant('talk', {
        type: 'risk',
        title: T('Estás hablando demasiado'),
        explanation: T('Llevas más del 65 % de la conversación. Quien pregunta controla la llamada.'),
        suggested_phrase: T('Hasta aquí, ¿qué te hace más sentido de lo que te conté y qué no?'),
      });
      words.sdr = 0; words.lead = 0;
    }
  }

  global.CoachHUD = {
    supported: hudSupported, isArc: isArc, pref: hudPref, setPref: hudSetPref,
    open: hudOpen, close: hudClose, toggle: hudToggle, isOpen: hudIsOpen,
  };
  global.CoachLive = {
    begin: begin, end: end, status: status, timer: timer, thinking: thinking,
    partial: partial, coach: coach, heard: heard, alertCard: alertCard, showAlert: showAlert, caption: caption,
    sellerSpeaking: sellerSpeaking,
    stageId: function () { return state.stageId; },
    minutes: function () { return startedAt ? Math.floor((Date.now() - startedAt) / 60000) : 0; },
    isLive: function () { return state.live; },
  };
})(window);
