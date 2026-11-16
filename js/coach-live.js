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

  var LS_HUD = 'predictable_coach_hud';
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
    };
  }
  var state = blank();

  // ═══ CoachHUD ═════════════════════════════════════════════════════════
  var hudWin = null;      // Window de la ventana flotante

  var HUD_CSS = [
    '*{box-sizing:border-box}',
    'html,body{margin:0;height:100%}',
    'body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b0f1a;color:#e8ecf5;display:flex;flex-direction:column;font-size:13px;line-height:1.45}',
    '.top{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#2bb673;box-shadow:0 0 8px rgba(43,182,115,.8);flex-shrink:0}',
    '.dot.off{background:#5b6478;box-shadow:none}',
    '.st{font-weight:600;font-size:12px;color:#b7c0d4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}',
    '.tm{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#8b95ab}',
    '.body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}',
    '.lbl{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8b95ab;margin-bottom:4px}',
    '.stage{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
    '.stage b{font-size:16px;color:#9db4ff}',
    '.goal{font-size:12px;color:#aab3c7;margin-top:2px}',
    '.say{background:linear-gradient(135deg,rgba(47,102,255,.22),rgba(6,182,212,.14));border:1px solid rgba(124,156,255,.45);border-radius:12px;padding:12px}',
    '.say .txt{font-size:16px;font-weight:650;color:#fff;line-height:1.4}',
    '.say.think .txt{opacity:.75}',
    '.next{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:10px 12px}',
    '.next ul{margin:0;padding-left:16px}',
    '.next li{margin:2px 0}',
    '.al{border-radius:10px;padding:10px 12px;border:1px solid;background:rgba(255,255,255,.04)}',
    '.al .t{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;margin-bottom:3px}',
    '.al .e{font-size:12px;color:#c3cbdb}',
    '.al .p{font-size:13.5px;font-weight:600;color:#fff;margin-top:6px}',
    '.last{font-size:11.5px;color:#8b95ab;border-top:1px solid rgba(255,255,255,.08);padding:8px 12px;flex-shrink:0;max-height:54px;overflow:hidden}',
    '.last b{color:#b7c0d4}',
    '.foot{display:flex;gap:8px;padding:8px 12px 10px;flex-shrink:0}',
    'button{font:inherit;font-size:12px;font-weight:600;border-radius:8px;padding:7px 10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e8ecf5;cursor:pointer;flex:1}',
    'button.end{color:#ff8d8d;border-color:rgba(225,84,84,.45)}',
    '.pulse{animation:p 1.2s ease-in-out infinite}',
    '@keyframes p{50%{opacity:.45}}',
    '@media (prefers-reduced-motion:reduce){.pulse{animation:none}}',
  ].join('');

  function hudSupported() { return 'documentPictureInPicture' in global; }
  function hudPref() { return lsGet(LS_HUD, true); }
  function hudSetPref(on) { lsSet(LS_HUD, !!on); }
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
    top.appendChild(el('span', 'tm', 'h-timer'));
    var body = el('div', 'body');
    var stageBox = el('div');
    var stageLbl = el('div', 'lbl'); stageLbl.id = 'h-stage-lbl';
    var stageRow = el('div', 'stage'); stageRow.appendChild(el('b', '', 'h-stage'));
    stageBox.appendChild(stageLbl); stageBox.appendChild(stageRow); stageBox.appendChild(el('div', 'goal', 'h-goal'));
    var say = el('div', 'say', 'h-say-box');
    say.appendChild(el('div', 'lbl', 'h-say-lbl'));
    say.appendChild(el('div', 'txt', 'h-say'));
    var next = el('div', 'next', 'h-next-box');
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
    d.body.appendChild(top); d.body.appendChild(body);
    d.body.appendChild(el('div', 'last', 'h-last'));
    d.body.appendChild(foot);
  }

  function hudRender() {
    if (!hudIsOpen()) return;
    var d = hudWin.document;
    function set(id, text) { var n = d.getElementById(id); if (n) n.textContent = text == null ? '' : String(text); return n; }
    var dot = d.getElementById('h-dot');
    if (dot) dot.className = 'dot' + (state.live ? '' : ' off');
    set('h-status', state.status ? T(state.status) : (state.live ? T('Escuchando') : T('Sin sesión activa')));
    set('h-timer', state.live ? state.timer : '');
    set('h-stage-lbl', T('Fase') + (state.prospect ? ' · ' + state.prospect : ''));
    set('h-stage', state.stage || '—');
    set('h-goal', state.goal || '');
    var sayBox = d.getElementById('h-say-box');
    if (sayBox) {
      sayBox.style.display = state.say ? '' : 'none';
      sayBox.className = 'say' + (state.thinking ? ' think' : '');
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
        var box = d.createElement('div'); box.className = 'al'; box.style.borderColor = c;
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
      if (hudSupported()) {
        hudWin = await global.documentPictureInPicture.requestWindow({ width: 380, height: 560 });
      } else {
        hudWin = global.open('', 'predictable-coach-hud', 'popup=yes,width=380,height=600');
        if (!hudWin) return false;
      }
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
    b.textContent = hudIsOpen() ? 'Cerrar ventana flotante' : 'Ventana flotante';
  }
  function hudToggle() { if (hudIsOpen()) hudClose(); else hudOpen(); }

  // ═══ CoachLive ════════════════════════════════════════════════════════
  var startedAt = 0;
  var ticker = null;
  var modelSpoke = false;        // el modelo ya dio una orden: manda sobre la plantilla
  var instantSeen = {};          // id de alerta instantánea → ts
  var nudgedStage = {};          // fase por la que ya se avisó el exceso de tiempo
  var words = { sdr: 0, lead: 0, lastNudge: 0 };
  var INSTANT_TTL_MS = 240000;

  function paintPage() {
    var st = document.getElementById('mc-stage');
    if (st) st.textContent = state.stage || '—';
    var goal = document.getElementById('mc-stage-goal');
    if (goal) goal.textContent = state.goal || '';
    var sayBox = document.getElementById('mc-say-box');
    var sayLbl = document.getElementById('mc-say-label');
    var say = document.getElementById('mc-say');
    if (sayBox) sayBox.style.display = state.say ? '' : 'none';
    if (sayLbl) sayLbl.textContent = T(state.sayLabel || 'Di esto ahora');
    if (say) { say.textContent = state.say || ''; say.style.opacity = state.thinking ? '.7' : '1'; }
    var ns = document.getElementById('mc-next-steps');
    if (ns) {
      ns.textContent = '';
      var items = state.next ? [state.next] : (state.doList || []);
      items.forEach(function (x) {
        var div = document.createElement('div');
        div.style.cssText = 'font-size:12px;padding:6px 8px;background:var(--surface2);border-radius:6px';
        div.textContent = x;
        ns.appendChild(div);
      });
    }
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
      state.say = T(s.say); state.sayLabel = 'Di esto ahora'; state.next = '';
    }
  }

  /** Arranca la sesión: fase de apertura y qué decir, antes de que nadie hable. */
  function begin(prospect, opts) {
    state = blank();
    state.live = true;
    state.status = (opts && opts.status) || 'Conectando…';
    state.prospect = (prospect && prospect.name) || '';
    startedAt = Date.now();
    modelSpoke = false; instantSeen = {}; nudgedStage = {};
    words = { sdr: 0, lead: 0, lastNudge: 0 };
    applyStage('rapport');
    if (ticker) clearInterval(ticker);
    ticker = setInterval(watch, 20000);
    paint();
    paintHudButton();
  }

  function end() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    state.live = false; state.thinking = false;
    state.status = 'Sesión finalizada';
    hudRender();
    // La ventana flotante solo tiene sentido con la sesión viva.
    setTimeout(function () { if (!state.live) hudClose(); }, 2500);
  }

  function status(text) { state.status = text || ''; hudRender(); }
  function timer(text) { state.timer = text || ''; if (hudIsOpen()) { var n = hudWin.document.getElementById('h-timer'); if (n) n.textContent = state.timer; } }
  function thinking(on) { state.thinking = !!on; paint(); }

  /** Texto parcial de la frase a decir, mientras el modelo todavía escribe. */
  function partial(sayText) {
    if (!sayText) return;
    state.say = sayText; state.sayLabel = 'Di esto ahora'; state.thinking = true;
    paint();
  }

  /**
   * Respuesta del modelo. Devuelve las alertas que se mostraron (las repetidas
   * las filtra quien llama).
   */
  function coach(out) {
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
    if (say) { state.say = say; state.sayLabel = 'Di esto ahora'; modelSpoke = true; }
    if (next) { state.next = next; modelSpoke = true; }
    (Array.isArray(out.alerts) ? out.alerts : []).forEach(function (a) { pushAlert(a); });
    paint();
  }

  function pushAlert(a) {
    if (!a || typeof a !== 'object') return;
    state.alerts.unshift(a);
    if (state.alerts.length > 4) state.alerts.length = 4;
  }

  function alertCard(a) {
    var color = { objection: 'var(--amber)', positive_signal: 'var(--green)', risk: 'var(--red)', stage_guidance: 'var(--gold)' }[a.type] || 'var(--teal)';
    var card = document.createElement('div');
    card.className = 'ai-suggestion ai-alert-dynamic';
    card.style.cssText = 'border:2px solid ' + color + ';background:rgba(245,158,11,.06)';
    var tag = document.createElement('div'); tag.className = 'ai-tag'; tag.style.color = color; tag.textContent = a.title || '';
    card.appendChild(tag);
    if (a.explanation) { var tx = document.createElement('div'); tx.className = 'ai-text'; tx.textContent = a.explanation; card.appendChild(tx); }
    if (a.suggested_phrase) {
      var box = document.createElement('div');
      box.style.cssText = 'background:var(--surface2);border-radius:6px;padding:10px;margin-top:8px;font-size:12px;line-height:1.7';
      var strong = document.createElement('strong'); strong.style.color = color; strong.textContent = 'Di esto:';
      box.appendChild(strong); box.appendChild(document.createElement('br'));
      box.appendChild(document.createTextNode(a.suggested_phrase));
      card.appendChild(box);
    }
    return card;
  }

  /** Alerta determinista (playbook): se pinta al instante, una vez por tema. */
  function instant(key, a) {
    var now = Date.now();
    if (instantSeen[key] && now - instantSeen[key] < INSTANT_TTL_MS) return null;
    instantSeen[key] = now;
    a.instant = true;
    pushAlert(a);
    var events = document.getElementById('mc-events');
    if (events) events.prepend(alertCard(a));
    // Mientras el modelo arma la respuesta a la medida, la plantilla es lo que
    // el vendedor puede decir YA.
    if (a.suggested_phrase) { state.say = a.suggested_phrase; state.sayLabel = 'Di esto ahora'; }
    paint();
    return a;
  }

  /**
   * Algo se dijo. `isLead` = lo dijo el prospecto. Con un resultado final del
   * lead se busca una objeción conocida y se responde sin esperar al modelo.
   */
  function heard(speaker, text, isFinal, isLead) {
    state.last = { speaker: speaker, text: text };
    if (isFinal) {
      var n = String(text || '').split(/\s+/).filter(Boolean).length;
      if (isLead) words.lead += n; else words.sdr += n;
      if (isLead && PB()) {
        var o = PB().detectObjection(text);
        if (o) {
          if (state.stageId !== 'close') applyStage('negotiation', true);
          instant('obj:' + o.id, { type: 'objection', title: T(o.title), explanation: T(o.why), suggested_phrase: T(o.say) });
          return;
        }
      }
    }
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
    supported: hudSupported, pref: hudPref, setPref: hudSetPref,
    open: hudOpen, close: hudClose, toggle: hudToggle, isOpen: hudIsOpen,
  };
  global.CoachLive = {
    begin: begin, end: end, status: status, timer: timer, thinking: thinking,
    partial: partial, coach: coach, heard: heard, alertCard: alertCard,
    stageId: function () { return state.stageId; },
    minutes: function () { return startedAt ? Math.floor((Date.now() - startedAt) / 60000) : 0; },
    isLive: function () { return state.live; },
  };
})(window);
