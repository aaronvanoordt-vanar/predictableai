/* auth-ambience.js — paralaje del lienzo + firma sonora sintetizada
   para auth.html. No toca ningún id que use js/auth.js; solo escucha.
   Sonido: Web Audio API generado en el momento (sin archivos de audio),
   silencioso hasta el primer gesto del usuario (política de autoplay de
   los navegadores) y con botón de silencio persistido en localStorage.

   Estética (reescrita el 2026-09-19): moderna, minimalista, AI native —
   TEXTURA, no melodía ni ritmo. Tres decisiones que no hay que deshacer:

   1. NADA de ondas cuadradas ni de notas de una escala mayor. La versión
      anterior disparaba tonos `square` en 880/1046.5/1318.5 Hz (La/Do/Mi):
      eso es un arpegio, y un arpegio en onda cuadrada suena a consola de
      8 bits. Los destellos de ahora son senoidales, cortos, mayormente
      mojados en reverb y sobre parciales altos del mismo fundamental, así
      que leen como brillo lejano y no como una melodía.
   2. NADA de pulso a tempo fijo. El "latido" cada 1.7 s era un metrónomo.
      El movimiento ahora es espectral: filtros y ganancias que derivan en
      ventanas de 18-45 s, independientes entre sí, para que el lecho nunca
      cierre un ciclo audible (tampoco es el LFO de "respiración" al
      unísono de un pad de meditación, que fue lo que se quitó antes).
   3. El cuerpo vive en 110-2000 Hz, no en 45 Hz. El zumbido sub-grave
      anterior era inaudible en parlantes de laptop y casi inaudible en
      audífonos — por eso "no se escuchaba" aunque el volumen estuviera
      arriba. El sub sigue estando (piso cálido), pero encima hay un núcleo
      armónico y una capa de aire filtrado en el rango donde el oído sí es
      sensible. Además todo pasa por un limitador (DynamicsCompressor), que
      es lo que permite subir el nivel sin que la suma de capas sature.

   Capas: sub (55 Hz) · núcleo armónico (octavas y quintas, sin terceras)
   · aire (ruido filtrado con barrido lento y paneo estéreo) · destellos
   dispersos. Todo con envío a una reverb de impulso generado. */
(function () {
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
     fuentes → (seco + envío a reverb) → master → limitador → salida.
     El limitador es lo que deja subir el nivel general sin distorsión
     cuando varias capas coinciden en fase. */
  var ctx = null;
  var master = null;       // volumen general
  var reverb = null;       // convolver con impulso generado
  var ambienceBus = null;  // solo el lecho continuo (lo que sube/baja el botón)
  var ambienceBuilt = false;
  var enabled = localStorage.getItem(SOUND_KEY) !== 'off';
  var started = false;
  var lastTick = 0;

  // Nivel del lecho. El valor viejo (0.075 sobre un master de 0.5) dejaba
  // el zumbido en torno a -28 dBFS: literalmente inaudible con audífonos.
  var AMBIENCE_LEVEL = 0.6;

  function now() { return ctx.currentTime; }

  function ensureCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(limiter);

    reverb = ctx.createConvolver();
    reverb.buffer = buildImpulse(3.2, 2.6);
    var reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.9;
    reverb.connect(reverbOut).connect(master);

    return ctx;
  }

  // Impulso sintético: ruido estéreo decreciendo en exponencial y oscurecido
  // con un filtro de un polo. Es lo que da la cola espaciosa; sin ella todo
  // suena seco y pequeño (parte de por qué la versión anterior sonaba a juego).
  function buildImpulse(seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      var prev = 0;
      for (var i = 0; i < len; i++) {
        var white = Math.random() * 2 - 1;
        prev = prev * 0.72 + white * 0.28;           // oscurece la cola
        data[i] = prev * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // Ruido rosado aproximado (Voss simplificado): más grave y menos sibilante
  // que el ruido blanco, que es lo que hace que la capa de aire lea como
  // "sala de servidores" y no como estática de radio.
  function buildNoiseBuffer(seconds) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      var b0 = 0, b1 = 0, b2 = 0;
      for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      }
    }
    return buf;
  }

  /* ── Utilidades de enrutado ─────────────────────────────────────────── */
  // Conecta una fuente al destino con una proporción seco/reverb.
  function route(node, destination, wet) {
    var dry = ctx.createGain();
    dry.gain.value = 1 - wet;
    node.connect(dry).connect(destination);
    if (wet > 0) {
      var send = ctx.createGain();
      send.gain.value = wet;
      node.connect(send).connect(reverb);
    }
  }

  // Deriva continua de un AudioParam entre dos valores, con tramos de
  // duración aleatoria: nunca repite el mismo ciclo, así que el lecho no
  // "loopea" al oído aunque lleve minutos sonando.
  function drift(param, min, max, minSec, maxSec) {
    (function step() {
      var target = min + Math.random() * (max - min);
      var dur = minSec + Math.random() * (maxSec - minSec);
      param.cancelScheduledValues(now());
      param.setValueAtTime(param.value, now());
      param.linearRampToValueAtTime(target, now() + dur);
      setTimeout(step, dur * 1000);
    })();
  }

  /* ── El lecho continuo ──────────────────────────────────────────────── */
  function buildAmbience() {
    if (ambienceBuilt) return;
    ambienceBuilt = true;

    ambienceBus = ctx.createGain();
    ambienceBus.gain.value = 0.0001;

    // El bus se reparte DESPUÉS del fader: seco al master y envío a la reverb.
    // Es importante que sea así y no que cada capa mande su propio envío por
    // fuera del bus — con envíos pre-fader, silenciar solo bajaba la parte
    // seca y la cola de la reverb seguía sonando indefinidamente.
    var ambDry = ctx.createGain(); ambDry.gain.value = 0.78;
    ambienceBus.connect(ambDry).connect(master);
    // El envío va filtrado en agudos: reverberar el sub solo embarra la cola.
    var ambSendHP = ctx.createBiquadFilter();
    ambSendHP.type = 'highpass'; ambSendHP.frequency.value = 180;
    var ambSend = ctx.createGain(); ambSend.gain.value = 0.5;
    ambienceBus.connect(ambSendHP).connect(ambSend).connect(reverb);

    // 1. Sub: piso cálido, deliberadamente discreto. Subirlo no hace que la
    //    página "suene más fuerte": los parlantes de laptop cortan por debajo
    //    de ~150 Hz, así que esa energía no se oye y sí se come el margen del
    //    limitador. El volumen percibido lo cargan el núcleo y el aire.
    //    Dos senoidales muy cercanas para que batan.
    var subFilter = ctx.createBiquadFilter();
    subFilter.type = 'lowpass'; subFilter.frequency.value = 110;
    var subGain = ctx.createGain(); subGain.gain.value = 0.13;
    subFilter.connect(subGain).connect(ambienceBus);
    [55, 55.13].forEach(function (f) {
      var o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      // 0.5 por oscilador: el par bate hasta sumar 1.0 y no más. Si cada uno
      // sale a amplitud plena, el pico del sub dispara el limitador y hace
      // "bombear" a todas las demás capas al ritmo del batido.
      var g = ctx.createGain(); g.gain.value = 0.5;
      o.connect(g).connect(subFilter); o.start();
    });

    // 2. Núcleo armónico: octavas y quintas sobre el mismo fundamental
    //    (sin terceras → ni alegre ni triste, solo presencia). Cada parcial
    //    deriva por su cuenta, así que el conjunto nunca "respira" al unísono.
    var coreFilter = ctx.createBiquadFilter();
    coreFilter.type = 'lowpass'; coreFilter.frequency.value = 900; coreFilter.Q.value = 0.6;
    var coreGain = ctx.createGain(); coreGain.gain.value = 0.62;
    coreFilter.connect(coreGain).connect(ambienceBus);
    drift(coreFilter.frequency, 520, 1500, 14, 30);
    [110, 164.81, 220, 329.63].forEach(function (f, i) {
      var o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      o.detune.value = (i % 2 ? 4 : -4);
      var g = ctx.createGain();
      g.gain.value = 0.22 / (1 + i * 0.5);
      o.connect(g).connect(coreFilter);
      o.start();
      drift(g.gain, 0.04, 0.24 / (1 + i * 0.5), 18, 42);
    });

    // 3. Aire: ruido rosado en bucle, barrido de banda lento y paneo estéreo.
    //    Es la capa que da el carácter "sistema encendido".
    var noise = ctx.createBufferSource();
    noise.buffer = buildNoiseBuffer(6);
    noise.loop = true;
    var airBand = ctx.createBiquadFilter();
    airBand.type = 'bandpass'; airBand.frequency.value = 760; airBand.Q.value = 0.85;
    var airTop = ctx.createBiquadFilter();
    airTop.type = 'lowpass'; airTop.frequency.value = 3200;
    var airGain = ctx.createGain(); airGain.gain.value = 0.62;
    var airPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    var airTail = airPan ? airGain.connect(airPan) : airGain;
    noise.connect(airBand).connect(airTop).connect(airGain);
    airTail.connect(ambienceBus);
    noise.start();
    drift(airBand.frequency, 380, 1900, 16, 38);
    drift(airGain.gain, 0.36, 0.9, 11, 25);
    if (airPan) drift(airPan.pan, -0.7, 0.7, 13, 29);

    scheduleShimmer();
  }

  // Destellos: granos senoidales cortísimos sobre parciales altos del mismo
  // fundamental (no una escala), casi todo reverb. Suenan a brillo lejano,
  // nunca a nota. Dispersos e irregulares a propósito.
  var SHIMMER = [659.25, 880, 987.77, 1318.5, 1760, 2637];
  function scheduleShimmer() {
    if (Math.random() < 0.78) {
      var f = SHIMMER[Math.floor(Math.random() * SHIMMER.length)];
      grain(f, {
        dur: 0.05 + Math.random() * 0.09,
        gain: 0.09 + Math.random() * 0.06,
        wet: 0.88,
        pan: (Math.random() * 2 - 1) * 0.8
      });
    }
    setTimeout(scheduleShimmer, 1500 + Math.random() * 3200);
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
  // Grano senoidal con envolvente suave. Siempre `sine`: cualquier onda con
  // armónicos duros (square/saw) devuelve el sonido a territorio chiptune.
  function grain(freq, opts) {
    if (!enabled || !ctx) return;
    opts = opts || {};
    var dur = opts.dur || 0.18;
    var peak = opts.gain != null ? opts.gain : 0.08;
    var t0 = now() + (opts.delay || 0);

    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + dur);

    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = opts.filterFreq || 5200;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var tail = g;
    if (opts.pan != null && ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = opts.pan;
      tail = g.connect(p);
    }
    osc.connect(filter).connect(g);
    route(tail, master, opts.wet != null ? opts.wet : 0.5);
    osc.start(t0);
    osc.stop(t0 + dur + 0.1);
  }

  // Barrido de ruido rosado: los "whoosh" y el encendido.
  function sweep(opts) {
    if (!enabled || !ctx) return;
    opts = opts || {};
    var dur = opts.dur || 0.8;
    var t0 = now() + (opts.delay || 0);

    var src = ctx.createBufferSource();
    src.buffer = buildNoiseBuffer(dur + 0.1);

    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = opts.q || 0.7;
    filter.frequency.setValueAtTime(opts.freqFrom || 240, t0);
    filter.frequency.exponentialRampToValueAtTime(opts.freqTo || 2400, t0 + dur);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain || 0.16, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter).connect(g);
    route(g, master, opts.wet != null ? opts.wet : 0.55);
    src.start(t0);
    src.stop(t0 + dur + 0.1);
  }

  /* ── Efectos ────────────────────────────────────────────────────────── */
  // Encendido: un barrido ascendente amplio + una caída de sub + el núcleo
  // floreciendo en la reverb. Lee como un sistema que arranca, no como una
  // fanfarria ni como un acorde sostenido de pad.
  function playIgnition() {
    sweep({ dur: 1, freqFrom: 180, freqTo: 4200, gain: 0.2, q: 0.6, wet: 0.6 });
    grain(220, { dur: 0.9, gain: 0.22, sweepTo: 55, filterFreq: 1200, wet: 0.35 });
    grain(880, { dur: 0.5, gain: 0.09, delay: 0.34, wet: 0.8, pan: -0.4 });
    grain(1318.5, { dur: 0.7, gain: 0.07, delay: 0.5, wet: 0.9, pan: 0.45 });
  }

  function playHoverTick() {
    var t = Date.now();
    if (t - lastTick < 110) return; // evita ráfagas al pasar el cursor rápido
    lastTick = t;
    grain(1760, { dur: 0.06, gain: 0.05, wet: 0.75 });
  }

  function playTabWhoosh() {
    sweep({ dur: 0.45, freqFrom: 700, freqTo: 3600, gain: 0.12, q: 1.1, wet: 0.65 });
  }

  // Confirmación: quinta ascendente, mojada. Dos notas, no una melodía.
  function playSuccessChime() {
    grain(440, { dur: 0.5, gain: 0.13, wet: 0.7 });
    grain(659.25, { dur: 0.9, gain: 0.11, delay: 0.11, wet: 0.85 });
  }

  function playErrorTone() {
    grain(196, { dur: 0.45, gain: 0.14, sweepTo: 110, filterFreq: 900, wet: 0.5 });
  }

  function start() {
    if (started || !enabled) return;
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume();
    started = true;
    playIgnition();
    buildAmbience();
    setAmbienceGain(AMBIENCE_LEVEL, 1.6); // el lecho entra detrás del encendido y se queda
  }

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
          grain(880, { dur: 0.2, gain: 0.08, wet: 0.7 });
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
