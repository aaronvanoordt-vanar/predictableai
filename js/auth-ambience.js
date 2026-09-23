/* auth-ambience.js — paralaje del lienzo + firma sonora sintetizada
   para auth.html. No toca ningún id que use js/auth.js; solo escucha.
   Sonido: Web Audio API generado en el momento (sin archivos de audio),
   silencioso hasta el primer gesto del usuario (política de autoplay de
   los navegadores) y con botón de silencio persistido en localStorage.

   Estética (reescrita el 2026-09-23, a pedido del dueño: "parece el sonido
   del mar, tiene que ser tecnológico, moderno"). Lo que sonaba a mar era la
   capa de "aire": ruido rosado con un pasabanda barriendo lento, ganancia
   que subía y bajaba y paneo de lado a lado — eso ES el sonido de una ola.
   Reglas para no volver ahí ni a lo de antes:

   1. NADA de ruido continuo con barridos lentos (= olas) ni de reverb larga
      y oscura como protagonista (= caverna/mar). El espacio lo da un eco
      estéreo tipo ping-pong, corto y filtrado: suena a electrónica, no a
      naturaleza. El ruido solo aparece en ráfagas de milisegundos (clics
      digitales) o en barridos puntuales de la interfaz.
   2. El cuerpo es un sintetizador: sierras desafinadas por un pasabajos
      resonante que se abre y se cierra, con una leve compresión rítmica
      ("sidechain") a 100 BPM. Es el pulso de la electrónica moderna, no un
      metrónomo: no hay golpe ni clic en el tiempo fuerte.
   3. NADA de ondas cuadradas ni arpegios (suenan a consola de 8 bits). Los
      "datos" son blips senoidales de milisegundos con una caída de tono
      (FM corta), dispersos con probabilidad sobre la rejilla de semicorcheas
      y repetidos por el eco.
   4. Todo pasa por un pasabajos maestro y un limitador. El pasabajos es lo
      que permite el "apagado" al iniciar sesión (fadeOut): el sonido se
      cierra y baja en ~1 s en vez de cortarse de golpe al cambiar de página.

   Capas: sub (55 Hz) · pad de sierras con filtro resonante y pulso · blips
   de datos con eco ping-pong · clics digitales. API: window.AuthAmbience. */
(function () {
  'use strict';

  var SOUND_KEY = 'pai_auth_sound';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  'use strict';

  var SOUND_KEY = 'pai_auth_sound';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  /* ── Paralaje del lienzo ────────────────────────────────────────────── */
  (function initParallax() {
    if (reduceMotion || coarsePointer) return;
    var sky = document.querySelector('.sky');
    if (!sky) return;
    var raf = null;
    window.addEventListener('pointermove', function (e) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = null;
        var px = (e.clientX / window.innerWidth - 0.5) * 2;
        var py = (e.clientY / window.innerHeight - 0.5) * 2;
        sky.style.setProperty('--px', (px * 16).toFixed(1));
        sky.style.setProperty('--py', (py * 12).toFixed(1));
      });
    }, { passive: true });
  })();

  /* ── Cadena de audio ─────────────────────────────────────────────────
     fuentes → (seco + envío al eco) → master → pasabajos maestro →
     limitador → salida. */
  var ctx = null;
  var master = null;       // volumen general (lo baja fadeOut)
  var masterLP = null;     // pasabajos maestro (lo cierra fadeOut)
  var echo = null;         // entrada del eco ping-pong
  var ambienceBus = null;  // solo el lecho continuo (lo que sube/baja el botón)
  var ambienceBuilt = false;
  var enabled = localStorage.getItem(SOUND_KEY) !== 'off';
  var started = false;
  var leaving = false;
  var lastTick = 0;

  var AMBIENCE_LEVEL = 0.55;
  var BPM = 100;
  var STEP = 60 / BPM / 4;         // semicorchea
  // La menor pentatónica en registro alto: los blips nunca forman una
  // melodía reconocible porque salen dispersos y al azar.
  var DATA_NOTES = [880, 1046.5, 1174.66, 1318.51, 1567.98, 1760];

  function now() { return ctx.currentTime; }

  function ensureCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 10;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);

    masterLP = ctx.createBiquadFilter();
    masterLP.type = 'lowpass';
    masterLP.frequency.value = 18000;
    masterLP.Q.value = 0.7;
    masterLP.connect(limiter);

    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(masterLP);

    echo = buildPingPong(STEP * 3, 0.38); // corchea con puntillo
    return ctx;
  }

  // Eco estéreo: izquierda y derecha se alimentan cruzadas, así cada
  // repetición salta de lado. El filtro dentro del lazo oscurece cada vuelta.
  function buildPingPong(time, feedback) {
    var input = ctx.createGain();
    var out = ctx.createGain(); out.gain.value = 0.7;
    var dl = ctx.createDelay(2), dr = ctx.createDelay(2);
    dl.delayTime.value = time; dr.delayTime.value = time;
    var fb = ctx.createGain(); fb.gain.value = feedback;
    var tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 3800;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 300;
    var merger = ctx.createChannelMerger(2);

    input.connect(hp).connect(dl);
    dl.connect(dr);
    dr.connect(tone).connect(fb).connect(dl);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    merger.connect(out).connect(master);
    return input;
  }

  function buildNoiseBuffer(seconds) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(1, len, rate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Conecta una fuente al destino con una proporción seco/eco.
  function route(node, destination, wet) {
    var dry = ctx.createGain();
    dry.gain.value = 1 - wet * 0.5;
    node.connect(dry).connect(destination);
    if (wet > 0) {
      var send = ctx.createGain();
      send.gain.value = wet;
      node.connect(send).connect(echo);
    }
  }

  // Deriva continua de un AudioParam entre dos valores con tramos de
  // duración aleatoria: el timbre del pad cambia sin cerrar un ciclo audible.
  function drift(param, min, max, minSec, maxSec) {
    (function step() {
      if (leaving) return;
      var target = min + Math.random() * (max - min);
      var dur = minSec + Math.random() * (maxSec - minSec);
      param.cancelScheduledValues(now());
      param.setValueAtTime(param.value, now());
      param.linearRampToValueAtTime(target, now() + dur);
      setTimeout(step, dur * 1000);
    })();
  }

  /* ── El lecho continuo ──────────────────────────────────────────────── */
  var pumpGain = null;

  function buildAmbience() {
    if (ambienceBuilt) return;
    ambienceBuilt = true;

    ambienceBus = ctx.createGain();
    ambienceBus.gain.value = 0.0001;
    ambienceBus.connect(master);
    // Envío post-fader al eco: al silenciar, también se apaga la cola.
    var send = ctx.createGain(); send.gain.value = 0.18;
    ambienceBus.connect(send).connect(echo);

    // 1. Sub: piso discreto (los parlantes de laptop no lo reproducen).
    var sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 55;
    var subGain = ctx.createGain(); subGain.gain.value = 0.16;
    sub.connect(subGain).connect(ambienceBus);
    sub.start();

    // 2. Pad de sierras: La + Mi (quinta, sin tercera) en dos octavas,
    //    desafinadas en pares para que el sonido sea ancho y "de sinte".
    pumpGain = ctx.createGain(); pumpGain.gain.value = 1;
    var padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass'; padFilter.frequency.value = 600; padFilter.Q.value = 6;
    var padGain = ctx.createGain(); padGain.gain.value = 0.085;
    padFilter.connect(padGain).connect(pumpGain).connect(ambienceBus);
    drift(padFilter.frequency, 320, 1600, 8, 18);
    drift(padFilter.Q, 3, 9, 10, 22);
    [[110, -9], [110, 9], [164.81, -6], [164.81, 6], [220, 0]].forEach(function (v, i) {
      var o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = v[0]; o.detune.value = v[1];
      var g = ctx.createGain(); g.gain.value = i === 4 ? 0.5 : 1;
      var p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) { p.pan.value = v[1] < 0 ? -0.5 : v[1] > 0 ? 0.5 : 0; o.connect(g).connect(p).connect(padFilter); }
      else o.connect(g).connect(padFilter);
      o.start();
    });

    scheduleSequencer();
  }

  /* ── Secuenciador: pulso + blips de datos + clics ──────────────────────
     Programa con anticipación (lookahead) sobre el reloj de audio, no con
     setTimeout directo: así el ritmo no se tambalea si la pestaña se ocupa. */
  var nextStepTime = 0;
  var stepIndex = 0;
  function scheduleSequencer() {
    nextStepTime = now() + 0.1;
    (function tick() {
      if (leaving) return;
      while (nextStepTime < now() + 0.25) {
        playStep(stepIndex, nextStepTime);
        nextStepTime += STEP;
        stepIndex = (stepIndex + 1) % 64;
      }
      setTimeout(tick, 60);
    })();
  }

  function playStep(i, t) {
    // Pulso tipo sidechain: el pad baja un poco en cada negra y se recupera.
    if (i % 4 === 0 && pumpGain) {
      pumpGain.gain.cancelScheduledValues(t);
      pumpGain.gain.setValueAtTime(0.55, t);
      pumpGain.gain.setTargetAtTime(1, t + 0.02, STEP * 1.1);
    }
    if (!enabled) return;
    // Blips de datos: más probables a contratiempo, nunca en todos los pasos.
    var p = (i % 2 === 1) ? 0.16 : 0.07;
    if (Math.random() < p) {
      var f = DATA_NOTES[Math.floor(Math.random() * DATA_NOTES.length)];
      blip(f, { at: t, gain: 0.05 + Math.random() * 0.04, pan: (Math.random() * 2 - 1) * 0.7, wet: 0.7 });
    }
    // Clics digitales: ruido de milisegundos, agudo, a los lados.
    if (Math.random() < 0.09) {
      click({ at: t + (Math.random() < 0.5 ? 0 : STEP / 2), gain: 0.05 + Math.random() * 0.05,
              pan: (Math.random() * 2 - 1) * 0.9 });
    }
  }

  function setAmbienceGain(target, rampSec) {
    if (!ambienceBus) return;
    var t = now();
    var current = Math.max(ambienceBus.gain.value, 0.0001);
    ambienceBus.gain.cancelScheduledValues(t);
    ambienceBus.gain.setValueAtTime(current, t);
    ambienceBus.gain.exponentialRampToValueAtTime(Math.max(target, 0.0001), t + (rampSec || 1.4));
  }

  /* ── Bloques de los efectos puntuales ───────────────────────────────── */
  function panned(node, pan) {
    if (pan == null || !ctx.createStereoPanner) return node;
    var p = ctx.createStereoPanner();
    p.pan.value = pan;
    return node.connect(p);
  }

  // Blip: senoidal con una caída de tono rapidísima (el "tik" de un dato).
  function blip(freq, opts) {
    if (!enabled || !ctx) return;
    opts = opts || {};
    var dur = opts.dur || 0.09;
    var t0 = opts.at != null ? opts.at : now() + (opts.delay || 0);
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * (opts.bend || 1.5), t0);
    osc.frequency.exponentialRampToValueAtTime(freq, t0 + 0.012);
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain || 0.08, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    route(panned(g, opts.pan), master, opts.wet != null ? opts.wet : 0.4);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // Clic: 6 ms de ruido por un pasaaltos.
  var clickBuffer = null;
  function click(opts) {
    if (!enabled || !ctx) return;
    if (!clickBuffer) clickBuffer = buildNoiseBuffer(0.02);
    var t0 = opts.at != null ? opts.at : now();
    var src = ctx.createBufferSource();
    src.buffer = clickBuffer;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 5000 + Math.random() * 3000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(opts.gain || 0.06, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.006);
    src.connect(hp).connect(g);
    route(panned(g, opts.pan), master, 0.25);
    src.start(t0);
    src.stop(t0 + 0.03);
  }

  // Sinte puntual: sierra por un pasabajos que se abre (o se cierra).
  function synthSweep(opts) {
    if (!enabled || !ctx) return;
    var dur = opts.dur || 1;
    var t0 = now() + (opts.delay || 0);
    var osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.freqTo) osc.frequency.exponentialRampToValueAtTime(opts.freqTo, t0 + dur);
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = opts.q || 8;
    f.frequency.setValueAtTime(opts.cutFrom, t0);
    f.frequency.exponentialRampToValueAtTime(opts.cutTo, t0 + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain || 0.1, t0 + Math.min(0.05, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(f).connect(g);
    route(panned(g, opts.pan), master, opts.wet != null ? opts.wet : 0.3);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /* ── Efectos ────────────────────────────────────────────────────────── */
  // Encendido: el filtro de un sinte se abre de golpe (power-up) y una
  // cascada ascendente de blips lo remata a través del eco.
  function playIgnition() {
    synthSweep({ freq: 55, dur: 1.2, cutFrom: 120, cutTo: 5200, q: 10, gain: 0.12 });
    synthSweep({ freq: 110, freqTo: 111, dur: 1.2, cutFrom: 160, cutTo: 3800, q: 6, gain: 0.06, pan: 0.4 });
    [880, 1318.51, 1760, 2637].forEach(function (f, i) {
      blip(f, { delay: 0.5 + i * STEP / 2, gain: 0.07, wet: 0.6, pan: i % 2 ? 0.5 : -0.5 });
    });
  }

  function playHoverTick() {
    var t = Date.now();
    if (t - lastTick < 110) return; // evita ráfagas al pasar el cursor rápido
    lastTick = t;
    blip(2637, { dur: 0.04, gain: 0.035, wet: 0.2 });
  }

  // Cambio de pestaña: un "zip" de sinte, no un soplido.
  function playTabWhoosh() {
    synthSweep({ freq: 220, freqTo: 440, dur: 0.22, cutFrom: 400, cutTo: 6000, q: 12, gain: 0.06, wet: 0.4 });
  }

  // Confirmación: dos blips en quinta ascendente.
  function playSuccessChime() {
    blip(1318.51, { dur: 0.16, gain: 0.08, wet: 0.5 });
    blip(1975.53, { dur: 0.3, gain: 0.07, delay: STEP, wet: 0.6 });
  }

  function playErrorTone() {
    synthSweep({ freq: 110, freqTo: 82.41, dur: 0.35, cutFrom: 900, cutTo: 200, q: 4, gain: 0.08, wet: 0.2 });
  }

  // Apagado al salir de la página: el pasabajos maestro se cierra y el
  // volumen baja a cero juntos. Devuelve una promesa que resuelve al final.
  function fadeOut(seconds) {
    var s = Math.max(0.05, seconds || 1);
    if (!ctx || !started || leaving) {
      leaving = true;
      return Promise.resolve();
    }
    leaving = true;
    var t = now();
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0, t + s);
    masterLP.frequency.cancelScheduledValues(t);
    masterLP.frequency.setValueAtTime(masterLP.frequency.value, t);
    masterLP.frequency.exponentialRampToValueAtTime(180, t + s);
    return new Promise(function (resolve) { setTimeout(resolve, s * 1000); });
  }

  function start() {
    if (started || !enabled || leaving) return;
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume();
    started = true;
    playIgnition();
    buildAmbience();
    setAmbienceGain(AMBIENCE_LEVEL, 1.6); // el lecho entra detrás del encendido y se queda
  }

  window.AuthAmbience = { fadeOut: fadeOut };

  /* ── Botón de silencio ──────────────────────────────────────────────── */
  var btn = document.getElementById('btn-sound');
  function reflectState() {
    if (!btn) return;
    btn.classList.toggle('on', enabled);
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    btn.setAttribute('aria-label', enabled ? 'Silenciar sonido ambiental' : 'Activar sonido ambiental');
  }
  reflectState();

  if (btn) {
    btn.addEventListener('click', function () {
      enabled = !enabled;
      localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off');
      reflectState();
      if (enabled) {
        if (!started) start();
        else {
          blip(1318.51, { dur: 0.12, gain: 0.06, wet: 0.4 });
          setAmbienceGain(AMBIENCE_LEVEL, 1);
        }
      } else if (started) {
        setAmbienceGain(0.0001, 0.6);
      }
    });
  }

  // Primer gesto real del usuario en la página: arranca el AudioContext
  // (los navegadores lo exigen) y dispara el encendido si sigue habilitado.
  ['pointerdown', 'keydown'].forEach(function (evt) {
    window.addEventListener(evt, start, { once: true, passive: true });
  });

  /* ── Efectos ligados a la interfaz existente ──────────────────────────── */
  document.querySelectorAll('.btn-oauth, .btn-primary, .auth-tabs button, .forgot-link').forEach(function (el) {
    el.addEventListener('mouseenter', playHoverTick);
  });
  var tabLogin = document.getElementById('tab-login');
  var tabSignup = document.getElementById('tab-signup');
  [tabLogin, tabSignup].forEach(function (el) {
    if (el) el.addEventListener('click', playTabWhoosh);
  });

  var status = document.getElementById('status');
  if (status && window.MutationObserver) {
    var seen = status.className;
    new MutationObserver(function () {
      if (status.className === seen) return;
      seen = status.className;
      if (status.classList.contains('ok')) playSuccessChime();
      else if (status.classList.contains('err')) playErrorTone();
    }).observe(status, { attributes: true, attributeFilter: ['class'] });
  }
})();
