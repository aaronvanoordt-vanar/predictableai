/* auth-ambience.js — paralaje del lienzo + sonido ambiental sintetizado
   para auth.html. No toca ningún id que use js/auth.js; solo escucha.
   Sonido: Web Audio API generado en el momento (sin archivos de audio),
   silencioso hasta el primer gesto del usuario (política de autoplay de
   los navegadores) y con botón de silencio persistido en localStorage.
   Estética deliberada: sala de máquinas / consola, NO pad de meditación —
   un zumbido sub-grave estable (sin LFO de "respiración" lenta que es lo
   que lee como spa), un pulso rítmico tipo latido/reloj y blips digitales
   dispersos (ruido filtrado + tonos cortos en onda cuadrada). Todo sigue
   sonando en loop mientras la pestaña esté abierta — no es un solo golpe
   de sonido al cargar. */
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

  /* ── Motor de sonido ────────────────────────────────────────────────── */
  var ctx = null;
  var master = null;
  var ambienceBus = null;
  var ambienceBuilt = false;
  var enabled = localStorage.getItem(SOUND_KEY) !== 'off';
  var started = false;
  var lastTick = 0;
  var AMBIENCE_LEVEL = 0.075;

  function ensureCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    return ctx;
  }

  function now() { return ctx.currentTime; }

  // Construye el lecho ambiental UNA vez: zumbido sub-grave fijo (sala de
  // máquinas, sin LFO de "respiración" — eso es lo que suena a meditación)
  // + los programadores del pulso/blips/ticks. Los osciladores del zumbido
  // arrancan y quedan sonando; el volumen del bus (ambienceBus) es lo único
  // que sube/baja después. Pulso/blips/ticks van directo al bus master (ver
  // tone()/noiseSweep()) y se silencian solos con el flag `enabled`.
  function buildAmbience() {
    if (ambienceBuilt) return;
    ambienceBuilt = true;

    ambienceBus = ctx.createGain();
    ambienceBus.gain.value = 0.0001;
    ambienceBus.connect(master);

    var humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass'; humFilter.frequency.value = 130;
    var humGain = ctx.createGain(); humGain.gain.value = 0.55;
    humFilter.connect(humGain).connect(ambienceBus);
    [45, 45.3].forEach(function (freq) {
      var o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(humFilter);
      o.start();
    });

    schedulePulse();
    scheduleDataBlip();
    scheduleTick();
  }

  // Pulso rítmico grave (late/reloj) — con jitter para que no suene a
  // metrónomo. Se reprograma indefinidamente; si el sonido está silenciado
  // tone() no emite nada, pero el reloj sigue vivo para retomar al instante.
  function schedulePulse() {
    tone(72, { type: 'sine', dur: 0.3, gain: 0.05, sweepTo: 52, filterFreq: 260 });
    setTimeout(schedulePulse, 1700 + Math.random() * 500);
  }

  // Blip de "transferencia de datos" — ruido filtrado corto y disperso.
  function scheduleDataBlip() {
    noiseSweep({ dur: 0.22, freqFrom: 2200, freqTo: 5200, gain: 0.03, q: 3 });
    setTimeout(scheduleDataBlip, 2600 + Math.random() * 2800);
  }

  var TICK_NOTES = [880, 1046.5, 1318.5];
  // Tick digital agudo, disperso y no siempre — actividad de sistema, no melodía.
  function scheduleTick() {
    if (Math.random() < 0.7) {
      var freq = TICK_NOTES[Math.floor(Math.random() * TICK_NOTES.length)];
      tone(freq, { type: 'square', dur: 0.05, gain: 0.012, filterFreq: 6000 });
    }
    setTimeout(scheduleTick, 3400 + Math.random() * 3200);
  }

  function setAmbienceGain(target, rampSec) {
    if (!ambienceBus) return;
    var t = now();
    var current = Math.max(ambienceBus.gain.value, 0.0001);
    ambienceBus.gain.cancelScheduledValues(t);
    ambienceBus.gain.setValueAtTime(current, t);
    ambienceBus.gain.exponentialRampToValueAtTime(Math.max(target, 0.0001), t + (rampSec || 1.2));
  }

  // Tono simple con envolvente ADR corta — el bloque base de todos los efectos.
  function tone(freq, opts) {
    if (!enabled || !ctx) return;
    opts = opts || {};
    var type = opts.type || 'sine';
    var dur = opts.dur || 0.18;
    var gainPeak = opts.gain != null ? opts.gain : 0.06;
    var delay = opts.delay || 0;
    var t0 = now() + delay;

    var osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + dur);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gainPeak, t0 + Math.min(0.03, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var filter = ctx.createBiquadFilter();
    filter.type = opts.filterType || 'lowpass';
    filter.frequency.value = opts.filterFreq || 4000;

    osc.connect(filter).connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // Barrido suave de ruido filtrado — usado en el "encendido" y el whoosh de pestañas.
  function noiseSweep(opts) {
    if (!enabled || !ctx) return;
    opts = opts || {};
    var dur = opts.dur || 1.1;
    var t0 = now() + (opts.delay || 0);
    var bufferSize = Math.floor(ctx.sampleRate * dur);
    var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    var src = ctx.createBufferSource();
    src.buffer = buffer;

    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = opts.q || 0.8;
    filter.frequency.setValueAtTime(opts.freqFrom || 200, t0);
    filter.frequency.exponentialRampToValueAtTime(opts.freqTo || 2200, t0 + dur);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain || 0.05, t0 + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // El "power-on" que abre la experiencia: un chirrido corto y ascendente
  // (~0.5s) más un blip de confirmación — no un acorde que se sostiene,
  // eso es lo que suena a pad ambiental. Una sola vez por sesión.
  function playIgnition() {
    noiseSweep({ dur: 0.55, freqFrom: 300, freqTo: 3400, gain: 0.05, q: 1.1 });
    tone(110, { type: 'sine', dur: 0.4, gain: 0.05, sweepTo: 440, filterFreq: 2400 });
    tone(880, { type: 'square', dur: 0.14, gain: 0.018, delay: 0.42, filterFreq: 5000 });
  }

  function playHoverTick() {
    var t = Date.now();
    if (t - lastTick < 90) return; // evita ráfagas al pasar el cursor rápido
    lastTick = t;
    tone(1200, { type: 'sine', dur: 0.05, gain: 0.018, filterFreq: 5000 });
  }

  function playTabWhoosh() {
    noiseSweep({ dur: 0.35, freqFrom: 600, freqTo: 3200, gain: 0.03, q: 1.4 });
  }

  function playSuccessChime() {
    tone(523.25, { type: 'sine', dur: 0.32, gain: 0.05, filterFreq: 3500 });
    tone(783.99, { type: 'sine', dur: 0.5, gain: 0.045, delay: 0.1, filterFreq: 3500 });
  }

  function playErrorTone() {
    tone(220, { type: 'sine', dur: 0.22, gain: 0.035, sweepTo: 160, filterFreq: 1400 });
  }

  function start() {
    if (started || !enabled) return;
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume();
    started = true;
    playIgnition();
    buildAmbience();
    setAmbienceGain(AMBIENCE_LEVEL, 1.1); // el zumbido entra justo detrás del chirrido y se queda sonando
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
          tone(880, { type: 'sine', dur: 0.12, gain: 0.03, filterFreq: 4000 });
          setAmbienceGain(AMBIENCE_LEVEL, 0.8);
        }
      } else if (started) {
        setAmbienceGain(0.0001, 0.5);
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
