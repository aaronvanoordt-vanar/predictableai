// js/realtime-coach.js
// ═══════════════════════════════════════════════════════════
// Real-Time Coach v3 — Grant Token de Deepgram.
// Worker da un token temporal (10 min). Cliente conecta DIRECTO
// a Deepgram con ese token. Sin WebSocket relay = sin bugs.
//
// Velocidad (2026-11-16): el coach responde en cuanto el LEAD termina de
// hablar (pausa corta, no el silencio largo de antes), la respuesta del
// modelo llega en streaming y la frase a decir se pinta mientras se escribe;
// la guía de la fase y la respuesta base a una objeción son instantáneas
// (js/coach-live.js + js/coach-playbook.js, sin IA). Cada turno se guarda en
// el servidor apenas se cierra: la transcripción completa no depende de que
// la pestaña llegue viva al final.
//
// Estabilidad y ritmo (2026-11-25):
//  • Audio en tramos de 50 ms por AudioWorklet (antes 256 ms en el hilo de la
//    página) y Deepgram nova-3 sin espera de formato: el texto aparece mientras
//    se habla, también a medio decir (línea tenue en la transcripción).
//  • Si la conexión con Deepgram se cae, se reconecta sola con un token nuevo.
//  • El coach responde cuando el LEAD termina una idea (pausa según si cerró la
//    frase), no con cada «ajá» ni mientras el vendedor habla; una respuesta que
//    quedó vieja porque el lead siguió hablando se descarta.
//  • El eco del lead que entra por el micrófono (parlantes) no cuenta como voz
//    del vendedor.
// ═══════════════════════════════════════════════════════════
(function (global) {
  const cfg = global.PREDICTABLE_CONFIG || {};
  const toast = (global.uiHelpers && global.uiHelpers.toast) ||
                function (msg) { console.log(msg); };

  let displayStream = null;
  let micStream = null;
  let audioCtx = null;
  let audioProcessor = null;
  let dgSocket = null;
  let coachInFlight = false;
  let coachPending = false;     // el silencio venció mientras el coach respondía
  let coachTimer = null;        // debounce de silencio antes de llamar al coach
  let chunkQueue = [];
  let elapsedTimer = null;
  let elapsedSeconds = 0;
  let currentMeetingId = null;
  let currentProspect = null;      // datos del lead elegido (sin investigación de mercado); lo leen los turnos del coach
  let recentTranscript = [];    // últimos turnos {speaker, text, ts, el}
  let pendingTurn = null;       // turno abierto: sigue recibiendo chunks del mismo hablante
  let totalTurns = 0;
  let totalWords = 0;
  let turnsAtLastCoach = 0;
  let wordsAtLastCoach = 0;
  let shownAlerts = [];         // {key, phrase, ts} de alertas ya mostradas
  let active = false;
  let trainedPrompt = null;     // {doctrine, block} de «Entrenamiento IA» (solo camino OpenAI/worker)
  // Llamada del dialer (js/dialer.js): el audio NO viene de compartir pantalla
  // sino de la propia llamada WebRTC — remoto = el lead, local = el SDR. Esos
  // tracks son de la llamada: el coach no los detiene al terminar.
  let callAudio = null;         // { remote: MediaStream, local: MediaStream|null }
  let sessionOpts = {};         // { meetingUrl, stayOnPage, onCoach(out), onEnded(meetingId) }
  let flushTimer = null;        // vacía la cola de turnos cada pocos segundos
  let streamOk = true;          // el worker aceptó `stream: true` (se apaga si lo rechaza)
  let lastStage = '';           // última fase que devolvió el modelo
  let ending = false;           // end() en curso (evita el doble cierre)
  let workletNode = null;
  let framesSent = 0;
  let sampleRate = 16000;       // el real del AudioContext (va en la URL de Deepgram)
  // Deepgram: modelo, reconexión y latido.
  let dgModel = 'nova-3';
  let dgEverOpened = false;     // esta sesión ya logró abrir el socket alguna vez
  let dgOpenedThis = false;     // el socket actual llegó a abrirse
  let dgRetries = 0;
  let dgRetryTimer = null;
  let dgKeepAlive = null;
  // Turnos: palabras por hablante y cuándo habló cada uno por última vez.
  let leadWords = 0, sdrWords = 0;
  let leadWordsAtCoach = 0, sdrWordsAtCoach = 0;
  let lastLeadAt = 0, lastSdrAt = 0;
  let coachKind = '';           // 'lead' | 'sdr': quién disparó el análisis agendado
  let runSeq = 0;               // respuesta vigente; una vieja se descarta
  let inflight = null;          // { seq, abort, prevTurns, prevWords, prevLead, prevSdr, leadAtStart }
  let leadRecent = [];          // [{ts, text}] lo último que dijo el lead (anti-eco)
  let lastInterim = null;       // {speaker, text} dicho a medias, aún sin resultado final
  const ghostEls = {};          // hablante → línea tenue de la transcripción
  const Live = function () { return global.CoachLive || null; };

  function workerUrl(path) {
    const base = (cfg.WORKER_URL || '').replace(/\/$/, '');
    return base + path;
  }

  // ─── PEDIR TOKEN TEMPORAL DE DEEPGRAM ─────────────────────
  async function getDeepgramToken() {
    const resp = await fetch(workerUrl('/deepgram-token'));
    if (!resp.ok) {
      const errTxt = await resp.text();
      throw new Error('Worker /deepgram-token HTTP ' + resp.status + ': ' + errTxt);
    }
    const data = await resp.json();
    if (!data.access_token) {
      throw new Error('Worker no devolvió access_token. Body: ' + JSON.stringify(data));
    }
    console.log('[Coach] Token Deepgram obtenido (expira en ' + data.expires_in + 's)');
    return data.access_token;
  }

  // ─── INICIO ───────────────────────────────────────────────
  /**
   * start(prospect) = captura de pantalla de siempre.
   * start(prospect, { streams: {remote, local}, meetingUrl, stayOnPage, onCoach, onEnded })
   * = la llamada del dialer: mismo pipeline (Deepgram → turnos → coach →
   * reporte en sales-coach), sin pedir pantalla ni micrófono.
   */
  async function start(prospectContext, opts) {
    sessionOpts = opts || {};
    callAudio = (sessionOpts.streams && sessionOpts.streams.remote) ? sessionOpts.streams : null;
    if (!cfg.WORKER_URL) {
      toast('WORKER_URL no configurado en js/config.js', 'error'); return;
    }
    // Sin lead no hay sesión: el reporte, el brief y el contexto del coach
    // dependen del contacto elegido en el selector del AI Sales Coach.
    if (!prospectContext || !(prospectContext.id || prospectContext.name)) {
      toast('Selecciona el lead de esta reunión antes de iniciar el coach.', 'warn');
      return;
    }
    // Guard de re-entrancy: un segundo start() sin cerrar el anterior filtra
    // el timer, el WebSocket y los tracks de mic/pantalla.
    if (active) { console.warn('[Coach] Ya hay una sesión activa; ignorando start().'); return; }
    active = true;
    ending = false;
    dgModel = cfg.COACH_STT_MODEL || 'nova-3';
    dgEverOpened = false; dgRetries = 0; framesSent = 0;
    currentProspect = prospectContext || null;
    // El camino OpenAI arma su prompt en el navegador: trae en paralelo el
    // entrenamiento del equipo. Si no llega, el coach usa su prompt de siempre.
    trainedPrompt = null;
    if (coachEngine() === 'openai' && global.AITraining) {
      global.AITraining.coachLivePrompt().then(function (p) { trainedPrompt = p; });
    }
    try {
      console.log('[Coach] 1/4 Pidiendo token a Deepgram via Worker...');
      const dgToken = await getDeepgramToken();

      if (callAudio) {
        console.log('[Coach] 2/4 Audio de la llamada del dialer (sin compartir pantalla)');
        micStream = callAudio.local || null;
      } else {
        console.log('[Coach] 2/4 Pidiendo captura de pantalla...');
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          // displaySurface:'monitor' hace que el picker abra en "Pantalla completa";
          // systemAudio:'include' muestra el checkbox de audio del sistema.
          video: { displaySurface: 'monitor' },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: 'include',
          monitorTypeSurfaces: 'include',
          selfBrowserSurface: 'exclude'
        });

        // Lo que importa es que llegue AUDIO. Una pestaña (la de Meet, Zoom o
        // Teams en el navegador) comparte su audio en cualquier sistema y se
        // sigue oyendo aunque cambies de pestaña; la pantalla completa necesita
        // «Compartir audio del sistema», que no todos los equipos ofrecen. Una
        // ventana de aplicación nunca trae audio. (Antes se rechazaba la
        // pestaña: en los equipos sin audio del sistema no había forma de iniciar.)
        if (displayStream.getAudioTracks().length === 0) {
          const vTrack = displayStream.getVideoTracks()[0];
          const surface = (vTrack && typeof vTrack.getSettings === 'function')
            ? vTrack.getSettings().displaySurface : null;
          cleanup();
          toast(surface === 'window'
            ? 'Una ventana no comparte audio. Comparte la pestaña de la reunión con «Compartir audio de la pestaña», o la pantalla completa con «Compartir audio del sistema».'
            : 'No se captó el audio de la reunión. Al compartir, activa «Compartir audio de la pestaña» (o «Compartir audio del sistema» si compartes la pantalla completa).', 'error');
          if (typeof coachShowIdle === 'function') coachShowIdle();
          return;
        }

        console.log('[Coach] 3/4 Pidiendo permiso del mic...');
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
          console.log('[Coach] Mic OK');
        } catch (e) {
          console.warn('[Coach] Sin mic:', e); micStream = null;
          toast('Sin acceso al micrófono: tu voz NO se transcribirá. Habilita el permiso ' +
            '(candado en la barra de direcciones) y reinicia el coach.', 'warn');
        }
      }

      console.log('[Coach] 4/4 Registrando meeting...');
      const res = await global.api.startMeeting({
        meeting_url: sessionOpts.meetingUrl || 'local-capture://realtime',
        prospect_id: prospectContext && prospectContext.id,
        prospect_name: prospectContext && prospectContext.name,
        context: prospectContext || {},
        mode: 'live'
      });
      currentMeetingId = res.meeting_id;
      active = true;
      // El servidor devuelve las reuniones anteriores con este lead y el equipo
      // ya acotado: el camino del worker arma su prompt aquí, así que los guarda.
      currentProspect = Object.assign({}, prospectContext, {
        history: Array.isArray(res.history) ? res.history : [],
        team: Array.isArray(res.team) ? res.team : (prospectContext.team || []),
      });

      clearUI();
      lastStage = '';
      if (Live()) Live().begin(prospectContext, { status: 'Conectando…', history: currentProspect.history });
      setStatus('connecting');
      elapsedSeconds = 0;
      elapsedTimer = setInterval(updateElapsed, 1000);
      // La transcripción se guarda sola mientras la reunión corre.
      flushTimer = setInterval(flushChunks, 4000);

      // Switch UI to active state
      if (!callAudio && typeof coachShowActive === 'function') {
        coachShowActive(prospectContext && prospectContext.name);
      }

      // ─── AUDIO PRIMERO (da la frecuencia real), LUEGO DEEPGRAM ─
      await startAudioCapture();
      if (!active) return;
      connectDeepgramDirect(dgToken);

      if (displayStream) {
        const stopped = function () { if (active && !ending) { toast('Dejaste de compartir: la sesión se cerró y el reporte se está generando.', 'warn'); end(); } };
        displayStream.getVideoTracks().forEach(function (t) { t.onended = stopped; });
        // El audio puede cortarse solo (se cerró la pestaña de la reunión).
        displayStream.getAudioTracks().forEach(function (t) { t.onended = stopped; });
      }
      toast('AI Sales Coach iniciado', 'success');
      return currentMeetingId;
    } catch (e) {
      console.error('[Coach] Start error:', e);
      // Cancelar el selector de pantalla no es un error: no asustes al usuario.
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
        toast('No se compartió nada, así que el coach no inició. Vuelve a intentarlo cuando quieras.', 'warn');
      } else {
        toast('No se pudo iniciar el coach: ' + (e && e.message ? e.message : 'error'), 'error');
      }
      cleanup();
      if (typeof coachShowIdle === 'function') coachShowIdle();
    }
  }

  // Procesador de audio fuera del hilo de la página: junta 50 ms de PCM
  // estéreo (canal 0 = reunión/lead, canal 1 = micrófono/vendedor) y los
  // entrega listos para Deepgram. En el hilo principal (ScriptProcessor, 256 ms
  // por tramo) cada repintado de la página atrasaba o cortaba el audio.
  const WORKLET_SRC = [
    'class PcmTap extends AudioWorkletProcessor {',
    '  constructor(o){ super(); const n = (o && o.processorOptions && o.processorOptions.frames) || 800; this.buf = new Int16Array(n * 2); this.n = 0; }',
    '  process(inputs){',
    '    const inp = inputs[0]; if (!inp || !inp[0]) return true;',
    '    const L = inp[0], R = inp[1] || null;',
    '    for (let i = 0; i < L.length; i++) {',
    '      const l = Math.max(-1, Math.min(1, L[i])), r = R ? Math.max(-1, Math.min(1, R[i])) : 0;',
    '      this.buf[this.n++] = l < 0 ? l * 0x8000 : l * 0x7FFF;',
    '      this.buf[this.n++] = r < 0 ? r * 0x8000 : r * 0x7FFF;',
    '      if (this.n >= this.buf.length) { const out = this.buf.slice(0); this.port.postMessage(out.buffer, [out.buffer]); this.n = 0; }',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('pcm-tap', PcmTap);",
  ].join('\n');

  function sendAudio(buffer) {
    if (!dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
    dgSocket.send(buffer);
    framesSent++;
    if (framesSent === 1) console.log('[Coach] Primer tramo de audio estéreo enviado (L=Lead, R=SDR)');
  }

  async function startAudioCapture() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      // El navegador puede no respetar los 16 kHz: a Deepgram se le dice el real.
      sampleRate = audioCtx.sampleRate || 16000;
      console.log('[Coach] AudioContext sampleRate:', sampleRate, 'state:', audioCtx.state);

      // Chrome puede crear el contexto 'suspended' (política de autoplay):
      // sin resume() el pipeline no procesa NI UN frame y el coach queda
      // sordo aunque el estado diga "Escuchando".
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(function () {
          console.log('[Coach] AudioContext reanudado, state:', audioCtx.state);
        }).catch(function (e) {
          console.error('[Coach] AudioContext resume falló:', e);
          toast('El navegador bloqueó la captura de audio. Haz clic en la página y reinicia el coach.', 'error');
        });
      }

      const tabAudio = new MediaStream(callAudio ? callAudio.remote.getAudioTracks() : displayStream.getAudioTracks());
      const tabSource = audioCtx.createMediaStreamSource(tabAudio);
      const tabGain = audioCtx.createGain();
      tabGain.gain.value = 1.0;
      tabSource.connect(tabGain);

      const merger = audioCtx.createChannelMerger(2);
      tabGain.connect(merger, 0, 0);

      if (micStream) {
        const micSource = audioCtx.createMediaStreamSource(micStream);
        const micGain = audioCtx.createGain();
        micGain.gain.value = 0.8;
        micSource.connect(micGain);
        micGain.connect(merger, 0, 1);
      } else {
        const silent = audioCtx.createConstantSource();
        silent.offset.value = 0;
        silent.start();
        silent.connect(merger, 0, 1);
      }

      // Salida muda hacia el destino: mantiene vivo el grafo sin que se oiga nada.
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      mute.connect(audioCtx.destination);

      let viaWorklet = false;
      if (audioCtx.audioWorklet && typeof AudioWorkletNode === 'function') {
        try {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
          try { await audioCtx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
          if (!audioCtx) return;   // la sesión se canceló mientras cargaba
          workletNode = new AudioWorkletNode(audioCtx, 'pcm-tap', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete',
            processorOptions: { frames: Math.round(sampleRate * 0.05) },
          });
          workletNode.port.onmessage = function (ev) { sendAudio(ev.data); };
          merger.connect(workletNode);
          workletNode.connect(mute);
          viaWorklet = true;
        } catch (e) {
          console.warn('[Coach] AudioWorklet no disponible, uso ScriptProcessor:', e && e.message);
          workletNode = null;
        }
      }
      if (!viaWorklet) {
        if (!audioCtx) return;
        audioProcessor = audioCtx.createScriptProcessor(2048, 2, 2);
        audioProcessor.onaudioprocess = function (e) {
          const left = e.inputBuffer.getChannelData(0);   // canal 0 = tab/Lead
          const right = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : new Float32Array(left.length);   // canal 1 = mic/SDR
          // STEREO intercalado L,R,L,R,... → Deepgram lo separa por channel_index
          const interleaved = new Int16Array(left.length * 2);
          for (let i = 0; i < left.length; i++) {
            const sL = Math.max(-1, Math.min(1, left[i]));
            const sR = Math.max(-1, Math.min(1, right[i]));
            interleaved[i*2] = sL < 0 ? sL * 0x8000 : sL * 0x7FFF;
            interleaved[i*2+1] = sR < 0 ? sR * 0x8000 : sR * 0x7FFF;
          }
          sendAudio(interleaved.buffer);
        };
        merger.connect(audioProcessor);
        audioProcessor.connect(mute);
      }
      console.log('[Coach] Captura de audio iniciada (' + (viaWorklet ? 'AudioWorklet 50 ms' : 'ScriptProcessor') + ')');

      // Watchdog: si a los 8s no salió ni un tramo de audio, avisar en la UI
      // en lugar de dejar la sesión "escuchando" en silencio indefinidamente.
      setTimeout(function () {
        if (active && framesSent === 0) {
          toast('No está llegando audio al coach. Verifica que activaste el audio al compartir ' +
            'y el permiso del micrófono, y reinicia la sesión.', 'error');
          if (Live()) Live().status('Sin audio', true);
        }
      }, 8000);
    } catch (e) {
      console.error('[Coach] AudioContext error:', e);
      toast('Error de audio: ' + e.message, 'error');
    }
  }

  // ─── DEEPGRAM DIRECTO (con token temporal) ─────────────────
  function connectDeepgramDirect(accessToken) {
    // STEREO + multichannel para separar SDR (canal 1) y Lead (canal 0).
    // no_delay: el texto no espera al formateo (smart_format lo retenía).
    const params = [
      'model=' + dgModel, 'language=multi',
      'interim_results=true', 'endpointing=300',
      'utterance_end_ms=1000', 'smart_format=true', 'punctuate=true', 'no_delay=true',
      'encoding=linear16', 'sample_rate=' + sampleRate, 'channels=2', 'multichannel=true'
    ].join('&');

    const url = 'wss://api.deepgram.com/v1/listen?' + params;
    console.log('[Coach] Conectando a Deepgram (' + dgModel + ')');
    // JWT Grant Token como Bearer en el subprotocolo. El token no se registra.
    const socket = new WebSocket(url, ['bearer', accessToken]);
    dgSocket = socket;
    dgOpenedThis = false;

    socket.onopen = function () {
      if (dgSocket !== socket) return;
      console.log('[Coach] Deepgram WS abierto ✓');
      dgOpenedThis = true; dgEverOpened = true; dgRetries = 0;
      setStatus('live');
      // Latido: sin audio unos segundos (pestaña en pausa) Deepgram cierra el socket.
      if (dgKeepAlive) clearInterval(dgKeepAlive);
      dgKeepAlive = setInterval(function () {
        if (socket.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify({ type: 'KeepAlive' })); } catch (e) {} }
      }, 4000);
    };
    socket.onmessage = function (event) {
      if (dgSocket !== socket) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'Results') handleTranscript(msg);
        else if (msg.type === 'UtteranceEnd') handleUtteranceEnd(msg);
      } catch (e) { console.warn('[Coach] DG parse error', e); }
    };
    socket.onerror = function (e) { console.error('[Coach] Deepgram error:', e); };
    socket.onclose = function (e) {
      if (dgSocket !== socket) return;      // un socket viejo: ya hay otro
      console.log('[Coach] Deepgram cerrado:', e.code, e.reason || '(sin razón)', 'wasClean:', e.wasClean);
      if (dgKeepAlive) { clearInterval(dgKeepAlive); dgKeepAlive = null; }
      dgSocket = null;
      if (!active || ending) return;
      reconnectDeepgram();
    };
  }

  // La conexión se cayó con la reunión viva (red, suspensión del equipo, o el
  // modelo no está disponible para la cuenta): se vuelve a abrir sola con un
  // token nuevo. Antes la transcripción se quedaba muda hasta reiniciar.
  function reconnectDeepgram() {
    if (dgRetryTimer || !active || ending) return;
    // Nunca abrió con el modelo nuevo: la cuenta no lo tiene → el de siempre.
    if (!dgEverOpened && !dgOpenedThis && dgModel !== 'nova-2') {
      console.warn('[Coach] ' + dgModel + ' no abrió; sigo con nova-2');
      dgModel = 'nova-2';
    } else {
      dgRetries++;
    }
    if (dgRetries > 8) {
      setStatus('lost');
      toast('Se perdió la conexión con la transcripción. Lo dicho hasta ahora está guardado: finaliza la sesión para ver el reporte.', 'error');
      return;
    }
    setStatus('reconnecting');
    const wait = dgRetries <= 1 ? 300 : Math.min(8000, 500 * Math.pow(2, dgRetries - 1));
    dgRetryTimer = setTimeout(async function () {
      dgRetryTimer = null;
      if (!active || ending) return;
      try {
        const token = await getDeepgramToken();
        if (!active || ending) return;
        connectDeepgramDirect(token);
      } catch (e) {
        console.warn('[Coach] no se pudo renovar el token de Deepgram:', e && e.message);
        reconnectDeepgram();
      }
    }, wait);
  }
  // Al volver la red o la pestaña, no esperes al siguiente reintento.
  global.addEventListener('online', function () {
    if (active && !ending && !dgSocket) { if (dgRetryTimer) { clearTimeout(dgRetryTimer); dgRetryTimer = null; } dgRetries = Math.min(dgRetries, 1); reconnectDeepgram(); }
  });

  // ─── Anti-eco ──────────────────────────────────────────────
  // Sin audífonos, la voz del lead sale por los parlantes y vuelve a entrar por
  // el micrófono: Deepgram la transcribe otra vez en el canal del vendedor. Eso
  // duplicaba líneas, inflaba «estás hablando demasiado» y confundía los turnos.
  function tokens(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 3; });
  }
  function isEcho(text) {
    if (callAudio || !micStream) return false;          // el dialer trae canales limpios
    const now = Date.now();
    if (now - lastLeadAt > 2500) return false;          // el lead no estaba hablando
    const mine = tokens(text);
    if (mine.length < 3) return false;
    leadRecent = leadRecent.filter(function (r) { return now - r.ts < 6000; });
    const bag = {};
    leadRecent.forEach(function (r) { tokens(r.text).forEach(function (w) { bag[w] = true; }); });
    let hit = 0;
    mine.forEach(function (w) { if (bag[w]) hit++; });
    return hit / mine.length >= 0.7;
  }

  function wordCount(text) { return String(text || '').split(/\s+/).filter(Boolean).length; }
  // ¿La frase quedó cerrada? Si el lead se detuvo a media idea («y además…»),
  // es una pausa para pensar: se le da más tiempo antes de responder.
  function endsThought(text) {
    const t = String(text || '').trim();
    if (/[.?!…]$/.test(t)) return !/\b(y|o|pero|porque|que|de|con|para|entonces|and|but|so|e|mas|porque)[.?!…]*$/i.test(t);
    return false;
  }

  function handleTranscript(msg) {
    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    if (!alt || !alt.transcript) return;
    const text = alt.transcript.trim();
    if (!text) return;

    const channelIdx = (msg.channel_index && msg.channel_index[0]) || 0;
    const speaker = channelIdx === 1 ? 'SDR' : 'Lead';
    const isLead = speaker === 'Lead';
    const isFinal = msg.is_final;
    const now = Date.now();

    if (isLead) {
      lastLeadAt = now;
      leadRecent.push({ ts: now, text: text });
      if (leadRecent.length > 40) leadRecent.shift();
    } else {
      if (isEcho(text)) { setGhost('SDR', ''); return; }
      lastSdrAt = now;
    }

    setGhost(speaker, isFinal ? '' : text);
    lastInterim = isFinal ? null : { speaker: speaker, text: text };
    if (Live()) Live().heard(speaker, text, isFinal, isLead);

    // El lead sigue hablando: cualquier análisis agendado espera a que termine.
    // Si habla el vendedor solo se cancela el análisis que disparó él mismo (el
    // que responde al lead sigue: la respuesta le sirve igual al terminar).
    if (isLead || coachKind === 'sdr') cancelScheduledCoaching();
    if (!isFinal) return;

    appendToTurn(speaker, text);
    const n = wordCount(text);
    if (isLead) {
      leadWords += n;
      // El lead agregó contenido mientras el modelo respondía a lo anterior:
      // esa respuesta ya nació vieja. Se descarta y se responde a todo junto.
      if (inflight && leadWords - inflight.leadAtStart >= 6) supersede();
      if (msg.speech_final) {
        const turnText = pendingTurn && pendingTurn.speaker === 'Lead' ? pendingTurn.text : text;
        scheduleCoaching(endsThought(turnText) ? (cfg.COACH_LEAD_PAUSE_MS || 450) : (cfg.COACH_LEAD_THINK_MS || 1100), 'lead');
      }
    } else {
      sdrWords += n;
      // El vendedor no necesita una frase nueva después de cada cosa que dice;
      // solo si lleva un buen tramo hablando (riesgo de monólogo).
      if (msg.speech_final && sdrWords - sdrWordsAtCoach >= (cfg.COACH_SDR_MIN_WORDS || 35)) {
        scheduleCoaching(cfg.COACH_SILENCE_MS || 1500, 'sdr');
      }
    }
  }

  // Deepgram parte un mismo mensaje en varios resultados "finales" (uno por
  // cada pausa de `endpointing` ms y cada pocos segundos de habla continua).
  // Antes cada chunk era una línea y el coach corría con 2 chunks, así que un
  // mensaje largo disparaba 3 respuestas iguales. Ahora los chunks se pegan en
  // un solo turno por hablante; el turno se cierra al cambiar de hablante,
  // cuando el coach lo analiza o al terminar la sesión.
  function appendToTurn(speaker, text) {
    if (pendingTurn && pendingTurn.speaker === speaker) {
      pendingTurn.text += ' ' + text;
    } else {
      closeTurn();
      pendingTurn = { speaker: speaker, text: text, ts: new Date().toISOString(), el: null };
      recentTranscript.push(pendingTurn);
      if (recentTranscript.length > 25) recentTranscript.shift();
      totalTurns++;
    }
    totalWords += wordCount(text);
    renderTurn(pendingTurn);
    // Un monólogo largo se guarda por tramos: si la pestaña se cierra a mitad
    // de la frase, se pierde como mucho el último tramo.
    if (pendingTurn.text.split(/\s+/).length > 80) closeTurn();
  }

  function closeTurn() {
    if (!pendingTurn) return;
    enqueueChunkForBackend({ speaker: pendingTurn.speaker, text: pendingTurn.text, ts: pendingTurn.ts });
    pendingTurn = null;
  }

  // UtteranceEnd = 1 s de silencio medido por Deepgram, POR CANAL
  // (`channel: [índice, total]`). El del lead dispara la respuesta ya; el del
  // vendedor solo cuenta si venía de un tramo largo.
  function handleUtteranceEnd(msg) {
    const idx = msg && Array.isArray(msg.channel) ? msg.channel[0] : 0;
    if (idx === 1) {
      if (sdrWords - sdrWordsAtCoach >= (cfg.COACH_SDR_MIN_WORDS || 35)) scheduleCoaching(400, 'sdr');
      return;
    }
    if (leadWords > leadWordsAtCoach) scheduleCoaching(150, 'lead');
  }

  function scheduleCoaching(delayMs, kind) {
    cancelScheduledCoaching();
    coachKind = kind || 'lead';
    coachTimer = setTimeout(function () {
      coachTimer = null;
      maybeRunCoaching(coachKind);
    }, delayMs == null ? (cfg.COACH_SILENCE_MS || 1500) : delayMs);
  }
  function cancelScheduledCoaching() {
    if (coachTimer) { clearTimeout(coachTimer); coachTimer = null; }
  }

  function maybeRunCoaching(kind) {
    if (!active || ending) return;
    if (coachInFlight) { coachPending = true; return; }
    const newLead = leadWords - leadWordsAtCoach;
    const newSdr = sdrWords - sdrWordsAtCoach;
    if (kind === 'sdr') {
      if (newSdr < (cfg.COACH_SDR_MIN_WORDS || 35)) return;
    } else {
      if (newLead < 1) return;
      // Un «ajá» / «sí, claro» del lead mientras el vendedor habla es escucha
      // activa, no un turno: no se interrumpe al vendedor con una frase nueva.
      const sellerTalking = Date.now() - lastSdrAt < 1200;
      if (newLead < (cfg.COACH_MIN_NEW_WORDS || 3) && sellerTalking) return;
    }
    runCoaching();
  }

  // La respuesta en curso quedó vieja: se corta y los contadores vuelven a como
  // estaban, para que el siguiente análisis vea todo lo nuevo junto.
  function supersede() {
    if (!inflight) return;
    const f = inflight;
    inflight = null;
    runSeq++;
    try { if (f.abort) f.abort.abort(); } catch (e) {}
    turnsAtLastCoach = f.prevTurns; wordsAtLastCoach = f.prevWords;
    leadWordsAtCoach = f.prevLead; sdrWordsAtCoach = f.prevSdr;
    coachInFlight = false;
    coachPending = false;
    hideThinking();
  }

  // ─── COACHING ──────────────────────────────────────────────
  //
  // Motor elegido por el usuario para el AI Sales Coach (OpenAI recomendado).
  // Con OpenAI seguimos usando el worker, que es la ruta de menor latencia y
  // ya está desplegada; con Claude o Perplexity el turno se resuelve en el
  // edge function sales-coach, que sí sabe hablar con los tres motores.
  function coachEngine() {
    return (global.AIEngine && global.AIEngine.get('coach')) || 'openai';
  }

  function formatTurn(t) { return t.speaker + ': ' + t.text; }

  async function runCoaching() {
    if (coachInFlight) return;
    coachInFlight = true;
    coachPending = false;
    cancelScheduledCoaching();
    closeTurn();
    showThinking();

    // Ventana de contexto = últimos 10 turnos, separando lo que el coach ya
    // vio de lo nuevo: las alertas deben salir SOLO de lo nuevo. Los
    // contadores se mueven antes de la llamada para que lo que llegue
    // mientras el modelo responde cuente como nuevo en el siguiente turno.
    // 10 turnos: suficiente para entender la fase y el prompt queda corto (cada
    // token de entrada es latencia).
    const windowTurns = recentTranscript.slice(-10);
    const newCount = Math.max(1, Math.min(windowTurns.length, totalTurns - turnsAtLastCoach));
    const prior = windowTurns.slice(0, windowTurns.length - newCount).map(formatTurn).join('\n');
    const fresh = windowTurns.slice(windowTurns.length - newCount).map(formatTurn).join('\n');
    const context = windowTurns.map(formatTurn).join('\n');
    const seq = ++runSeq;
    const abort = (typeof AbortController === 'function') ? new AbortController() : null;
    inflight = {
      seq: seq, abort: abort,
      prevTurns: turnsAtLastCoach, prevWords: wordsAtLastCoach,
      prevLead: leadWordsAtCoach, prevSdr: sdrWordsAtCoach,
      leadAtStart: leadWords,
    };
    turnsAtLastCoach = totalTurns;
    wordsAtLastCoach = totalWords;
    leadWordsAtCoach = leadWords;
    sdrWordsAtCoach = sdrWords;

    function onFailure(e) {
      if (seq !== runSeq) return;             // ya la reemplazó otra: nada que deshacer
      console.error('Coaching error', e);
      hideThinking();
      // Que lo nuevo se reintente en el siguiente silencio.
      const f = inflight;
      if (f && f.seq === seq) {
        turnsAtLastCoach = f.prevTurns; wordsAtLastCoach = f.prevWords;
        leadWordsAtCoach = f.prevLead; sdrWordsAtCoach = f.prevSdr;
      }
    }
    function onSuccess(parsed) {
      if (seq !== runSeq || !active) return;  // respuesta vieja: se descarta
      const out = parsed || {};
      // Un turno vacío (el servidor lo devuelve así cuando el modelo falló) no
      // consume lo nuevo: se reintenta en el siguiente silencio.
      if (!out.say_now && !out.next_step && !out.stage && !(out.alerts && out.alerts.length)) {
        onFailure(new Error('turno vacío'));
        return;
      }
      hideThinking();
      const shown = renderCoachOutput(out, seq);
      enqueueEventForBackend(shown);
    }
    function done() {
      if (seq !== runSeq) return;             // la reemplazada no libera a la nueva
      inflight = null;
      coachInFlight = false;
      if (coachPending && active) scheduleCoaching(150, 'lead');
    }
    // Lo que el modelo necesita para ubicar la fase sin releer toda la llamada.
    const minute = Live() ? Live().minutes() : Math.floor(elapsedSeconds / 60);
    const hadMeetings = currentProspect && Array.isArray(currentProspect.history) && currentProspect.history.length;
    const position = 'Minuto de la llamada: ' + minute + '. Fase anterior: ' + (lastStage || (hadMeetings ? 'la llamada acaba de empezar; continúa desde la reunión anterior' : 'rapport (la llamada acaba de empezar)')) + '.';

    if (coachEngine() !== 'openai') {
      try {
        const parsed = await global.api.coachTurn({
          meeting_id: currentMeetingId,
          transcript: context,
          prior_transcript: prior,
          new_transcript: fresh,
          context: currentProspect || {},
          position: position,
        });
        onSuccess(parsed);
      } catch (e) {
        onFailure(e);
      } finally { done(); }
      return;
    }

    // Espejo de languageDirective() de _shared/llm.ts: este camino no pasa por
    // callLLM, así que el idioma elegido (js/i18n.js) se agrega aquí.
    function outputLanguageDirective() {
      const lang = global.i18n ? global.i18n.get() : 'es';
      if (lang === 'es') return '';
      const name = lang === 'pt-BR' ? 'Brazilian Portuguese (pt-BR)' : 'English';
      const style = lang === 'pt-BR' ? ' Write natural, professional Brazilian Portuguese as a Brazilian B2B seller would — address the reader as "você", use Brazilian vocabulary and spelling (never European Portuguese), and rewrite idioms instead of translating Spanish word for word. Where an instruction above says to use "tú" or "usted", apply it as "você" (informal) or "o senhor / a senhora" (formal).' : '';
      return '\n\n=== OUTPUT LANGUAGE (overrides everything above) ===\nThe user reads the product in ' + name + '. Every human-readable string in your answer — titles, summaries, bullet points, messages, objections, actions, JSON string values meant for a person — MUST be written in ' + name + ', even where an instruction above says "en español" / "in Spanish".' + style + ' Keep JSON keys, enum values, ids, URLs, company names and proper nouns exactly as specified.';
    }
    // Espejo corto de NEURO_DOCTRINE (supabase/functions/_shared/sales-training.ts):
    // este camino solo corre cuando el motor es OpenAI vía el worker. Si el
    // equipo entrenó su IA («Entrenamiento IA»), la doctrina corta se cambia
    // por la misma doctrina y el mismo bloque que usa sales-coach.
    const doctrine = (trainedPrompt && trainedPrompt.doctrine) ? [trainedPrompt.doctrine] : [
      'Hablas como un entrenador de neuroventas de la escuela de Jürgen Klarić: directo, frases cortas, sin teoría.',
      'Véndele a la mente: primero el cerebro reptil (miedo a perder, seguridad, poder, ahorrar tiempo), luego la emoción, al final los datos.',
      'Objeciones en 3 movimientos: valida la emoción, reencuadra al miedo/deseo del lead, pregunta que lleva a un sí pequeño. Nunca pelees con su proveedor actual.',
      'Cada dato del lead (dolor, meta, plazo, presupuesto, decisor) es una puerta: si el vendedor la deja pasar, dile la pregunta exacta para abrirla.',
      'Si el vendedor habla más del 60 %, ordénale callarse y preguntar. Sin siguiente paso con fecha no hay cierre.',
    ].concat(global.CoachPlaybook ? ['Fases y objetivo de cada una (no se salta ninguna):'].concat(global.CoachPlaybook.STAGES.map(function (s) {
      return '- ' + s.id + ' (' + s.label + '): ' + s.goal;
    })) : []);
    const systemPrompt = [
      'Eres el coach de ventas de Predictable.ai en vivo, al oído del vendedor durante una llamada B2B.',
    ].concat(doctrine, [
      'La conversación tiene 2 hablantes: "Lead" y "SDR" (el vendedor).',
      'Recibes la parte de la conversación que ya analizaste (solo contexto) y lo NUEVO.',
      'Genera alertas SOLO sobre lo nuevo; no repitas alertas de la parte anterior.',
      '"say_now" es LO PRIMERO que escribes: la frase exacta, lista para leer en voz alta, que el vendedor debe decir AHORA según la fase y lo último que dijo el lead (máximo 2 frases; siempre trae una, también al inicio de la llamada).',
      '"next_step" es la orden para este instante, en imperativo, una frase; siempre trae una. "suggested_phrase" es la frase exacta de esa alerta.',
      'Sé breve: máximo 2 alertas, explicación de una frase. La velocidad importa más que el detalle.',
      'OUTPUT: SOLO JSON, con las claves en este orden:',
      '{',
      '  "say_now": "",',
      '  "next_step": "",',
      '  "stage": "rapport|discovery|reframe|demo|negotiation|close",',
      '  "alerts": [{ "type":"objection|positive_signal|risk|stage_guidance", "title":"", "explanation":"", "suggested_phrase":"" }]',
      '}',
      'Español neutro. NO inventes alertas: si no hay nada accionable, "alerts": [].'
    ]).join('\n') + ((trainedPrompt && trainedPrompt.block) ? '\n' + trainedPrompt.block : '') + outputLanguageDirective();
    // Equipo del vendedor y reuniones anteriores: bloque aparte (espejo corto de
    // meetingFramingBlock de sales-coach) para que el límite del JSON no lo corte.
    const cp = currentProspect || {};
    const leadJson = Object.assign({}, cp); delete leadJson.history; delete leadJson.team;
    const userContent = 'Contexto del prospecto (sus datos, tus notas, las fuentes que agregaste, la oportunidad del CRM, lo que ya se sabe de conversaciones anteriores y la investigación previa de cada persona; esa investigación es una hipótesis: si el lead dice otra cosa, manda lo que dice el lead):\n' + JSON.stringify(leadJson).slice(0, 9000) + '\n\n' +
      framingText(cp) +
      position + '\n\n' +
      (prior ? 'Conversación anterior (ya analizada, solo contexto):\n' + prior + '\n\n' : '') +
      'Lo nuevo (analiza solo esto):\n' + fresh;

    const body = {
      model: cfg.LLM_MODEL || 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 450,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ]
    };
    try {
      let content = null;
      if (streamOk) {
        try { content = await streamCompletion(body, seq, abort); }
        catch (e) {
          if (seq !== runSeq) throw e;        // la cortamos nosotros: no es un fallo del worker
          // Un worker que no acepta streaming no deja al coach mudo: se repite
          // la llamada completa y no se vuelve a intentar en esta sesión.
          console.warn('[Coach] streaming no disponible, sigo sin él:', e && e.message);
          streamOk = false;
        }
      }
      if (content == null) {
        const resp = await fetch(workerUrl('/openai'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: abort ? abort.signal : undefined
        });
        if (!resp.ok) throw new Error('OpenAI ' + resp.status + ': ' + await resp.text());
        const data = await resp.json();
        content = data.choices && data.choices[0] && data.choices[0].message.content;
      }
      if (!content) throw new Error('vacío');
      onSuccess(JSON.parse(content));
    } catch (e) {
      onFailure(e);
    } finally { done(); }
  }

  function framingText(cp) {
    const out = [];
    const team = Array.isArray(cp.team) ? cp.team.filter(function (t) { return t && t.name; }) : [];
    if (team.length) {
      out.push('EQUIPO DEL VENDEDOR EN ESTA LLAMADA: además del vendedor participan de SU empresa ' +
        team.map(function (t) { return t.name; }).join(', ') +
        '. Son vendedores, NO leads: no les recomiendes venderles ni trates lo que dicen como objeciones o señales de compra. Entran por el audio de la reunión, así que pueden aparecer dentro del canal "Lead": reconócelos por su nombre y por lo que dicen. Todo otro hablante es del lado del lead.');
    }
    const hist = Array.isArray(cp.history) ? cp.history.slice(0, 4) : [];
    if (hist.length) {
      out.push('REUNIONES ANTERIORES CON ESTAS PERSONAS (esta es la n.º ' + (hist.length + 1) + '; la más reciente primero):');
      hist.forEach(function (h) {
        const head = [String(h.date || '').slice(0, 10), h.stage ? 'llegó hasta: ' + h.stage : '', h.outcome ? 'resultado: ' + h.outcome : ''].filter(Boolean).join(' · ');
        out.push('- ' + head + ' — ' + (Array.isArray(h.summary) ? h.summary.join(' ') : '').slice(0, 600) +
          (h.next_step && h.next_step.accion ? ' Siguiente paso acordado: ' + h.next_step.accion + (h.next_step.cuando ? ' (' + h.next_step.cuando + ')' : '') + '.' : '') +
          (Array.isArray(h.objections) && h.objections.length ? ' Objeciones: ' + h.objections.map(function (o) { return o.objection + (o.result ? ' [' + o.result + ']' : ''); }).join(' | ') + '.' : ''));
      });
      out.push('ESTA NO ES LA PRIMERA REUNIÓN. No recomiendes presentarse ni repetir el descubrimiento ya hecho: abre retomando el siguiente paso acordado y lo pendiente, y sitúa la fase a partir de donde llegó la anterior. Las objeciones ya superadas no se reabren; las no resueltas sí.');
    }
    return out.length ? out.join('\n') + '\n\n' : '';
  }

  // Respuesta en streaming (SSE de OpenAI a través del worker). Devuelve el
  // JSON completo como texto y, mientras llega, pinta la frase "say_now" a
  // medio escribir: el vendedor empieza a leer ~1 s antes de que termine.
  async function streamCompletion(body, seq, abort) {
    const resp = await fetch(workerUrl('/openai'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, body, { stream: true })),
      signal: abort ? abort.signal : undefined
    });
    if (!resp.ok) throw new Error('OpenAI ' + resp.status);
    const type = resp.headers.get('content-type') || '';
    if (type.indexOf('text/event-stream') === -1 || !resp.body) {
      // El worker respondió completo (ignoró stream): sirve igual.
      const data = await resp.json();
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', content = '', shown = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (d) content += d;
        } catch (e) { /* línea partida: llega completa en el siguiente trozo */ }
      }
      const say = partialString(content, 'say_now');
      if (seq !== runSeq) { try { reader.cancel(); } catch (e) {} throw new Error('reemplazada'); }
      if (say && say !== shown && say.length - shown.length >= 6 && Live() && active) {
        shown = say;
        Live().partial(say, seq);
      }
    }
    return content;
  }

  // Valor (posiblemente sin terminar) de una clave string en un JSON a medio
  // llegar. Corta en la última palabra completa para no pintar medias sílabas.
  function partialString(json, key) {
    const m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(json);
    if (!m) return '';
    let raw = m[1].replace(/\\$/, '');
    try { raw = JSON.parse('"' + raw + '"'); } catch (e) { return ''; }
    const closed = json.charAt(m.index + m[0].length) === '"';
    return closed ? raw : raw.replace(/\s+\S*$/, '');
  }

  // ─── Persistencia, UI, end(), cleanup() ────────────────────
  // Cada turno se manda al servidor apenas se cierra (antes se juntaban de a
  // tres y, si la pestaña moría, se perdía el final de la reunión).
  function enqueueChunkForBackend(c) { chunkQueue.push(c); flushChunks(); }
  let flushing = false;
  async function flushChunks(opts) {
    if (!currentMeetingId || chunkQueue.length === 0 || flushing) return;
    flushing = true;
    const batch = chunkQueue.splice(0);
    try { await global.api.ingestLocalChunks({ meeting_id: currentMeetingId, chunks: batch }, opts); }
    catch (e) { chunkQueue = batch.concat(chunkQueue); }
    finally { flushing = false; }
  }
  // La pestaña se cierra o se recarga con la reunión viva: se guarda lo que
  // falte con keepalive para que el reporte tenga la transcripción completa.
  global.addEventListener('pagehide', function () {
    if (!active || !currentMeetingId) return;
    closeTurn();
    flushing = false;
    flushChunks({ keepalive: true });
  });
  async function enqueueEventForBackend(ev) {
    if (!currentMeetingId) return;
    try { await global.api.ingestLocalEvent({ meeting_id: currentMeetingId, event: ev }); } catch (e) {}
  }

  function clearUI() {
    cancelScheduledCoaching();
    pendingTurn = null; recentTranscript = []; shownAlerts = [];
    totalTurns = 0; totalWords = 0; turnsAtLastCoach = 0; wordsAtLastCoach = 0;
    leadWords = 0; sdrWords = 0; leadWordsAtCoach = 0; sdrWordsAtCoach = 0;
    lastLeadAt = 0; lastSdrAt = 0; leadRecent = []; lastInterim = null;
    inflight = null; coachInFlight = false;
    coachPending = false;
    Object.keys(ghostEls).forEach(function (k) { delete ghostEls[k]; });
    const t = document.getElementById('mc-transcript'); if (t) t.textContent = '';
    const e = document.getElementById('mc-events');
    if (e) Array.from(e.querySelectorAll('.ai-alert-dynamic')).forEach(function (el) { el.remove(); });
    const empty = document.getElementById('mc-events-empty'); if (empty) empty.style.display = '';
    hideThinking();
  }
  function turnRow(speaker, ghost) {
    const div = document.createElement('div');
    div.className = 'mc-tr-row notranslate' + (speaker === 'SDR' ? ' is-sdr' : ' is-lead') + (ghost ? ' is-ghost' : '');
    const who = document.createElement('span');
    who.className = 'mc-tr-who';
    who.textContent = speaker + ':';
    const what = document.createElement('span');
    what.className = 'mc-tr-text';
    div.appendChild(who); div.appendChild(document.createTextNode(' ')); div.appendChild(what);
    return { row: div, text: what };
  }
  // Lo que se está diciendo AHORA, antes de que Deepgram lo dé por final: una
  // línea tenue al pie de la transcripción, por hablante. Así el texto aparece
  // mientras se habla y no un par de segundos después.
  function setGhost(speaker, text) {
    const c = document.getElementById('mc-transcript'); if (!c) return;
    let g = ghostEls[speaker];
    if (!text) { if (g) { g.row.remove(); delete ghostEls[speaker]; } return; }
    const stick = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
    if (!g) { g = ghostEls[speaker] = turnRow(speaker, true); }
    g.text.textContent = text;
    c.appendChild(g.row);       // siempre al final
    if (stick) c.scrollTop = c.scrollHeight;
  }
  // Una línea por turno: mientras el hablante sigue, la misma línea crece.
  function renderTurn(turn) {
    const c = document.getElementById('mc-transcript'); if (!c) return;
    // Solo sigue el final si el usuario no subió a releer algo.
    const stick = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
    if (!turn.el) {
      const r = turnRow(turn.speaker, false);
      c.appendChild(r.row);
      turn.el = r.text;
      // Las líneas tenues siempre quedan debajo de lo ya confirmado.
      Object.keys(ghostEls).forEach(function (k) { c.appendChild(ghostEls[k].row); });
    }
    turn.el.textContent = turn.text;
    if (stick) c.scrollTop = c.scrollHeight;
  }
  function alertKey(a) {
    return String(a.type || '') + '|' + String(a.title || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }
  // El modelo tiende a repetir la misma alerta mientras el tema sigue en la
  // ventana: una alerta con el mismo título/tipo o la misma frase sugerida
  // que otra reciente no se vuelve a mostrar ni a guardar.
  function isDuplicateAlert(a) {
    const now = Date.now();
    const ttl = cfg.COACH_ALERT_DEDUP_MS || 240000;
    shownAlerts = shownAlerts.filter(function (s) { return now - s.ts < ttl; });
    const key = alertKey(a);
    const phrase = String(a.suggested_phrase || '').trim().toLowerCase();
    return shownAlerts.some(function (s) { return s.key === key || (phrase && s.phrase === phrase); });
  }
  function renderCoachOutput(out, seq) {
    const alerts = (out.alerts || []).filter(function (a) {
      if (!a || typeof a !== 'object' || isDuplicateAlert(a)) return false;
      shownAlerts.push({ key: alertKey(a), phrase: String(a.suggested_phrase || '').trim().toLowerCase(), ts: Date.now() });
      return true;
    });
    // Mismas tarjetas que la capa instantánea (js/coach-live.js): un solo estilo.
    if (Live()) alerts.forEach(function (a) { Live().showAlert(a); });
    const shown = { alerts: alerts, stage: out.stage || '', next_step: out.next_step || '', say_now: out.say_now || '' };
    if (out.stage) lastStage = String(out.stage);
    if (typeof sessionOpts.onCoach === 'function') {
      try { sessionOpts.onCoach(shown); } catch (e) {}
    }
    // Fase, frase a decir y orden: en la página y en la ventana flotante.
    if (Live()) Live().coach(shown, seq);
    return shown;
  }
  // «Analizando»: una señal discreta junto a la frase (antes era una tarjeta
  // que aparecía y desaparecía en la lista de alertas con cada turno).
  function showThinking() { if (Live()) Live().thinking(true); }
  function hideThinking() { if (Live() && active) Live().thinking(false); }
  function setStatus(s) {
    const el = document.getElementById('mc-status'); if (!el) return;
    const map = {
      connecting: 'Conectando…', live: 'Escuchando (tú y el lead)', ended: 'Sesión finalizada',
      reconnecting: 'Reconectando la transcripción…', lost: 'Transcripción desconectada',
    };
    el.textContent = map[s] || s;
    const warn = s === 'reconnecting' || s === 'lost';
    const bar = document.getElementById('mc-livebar');
    if (bar) bar.classList.toggle('is-warn', warn);
    if (Live() && s !== 'ended') Live().status(s === 'live' ? 'Escuchando' : (map[s] || s), warn);
  }
  function updateElapsed() {
    elapsedSeconds++;
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const el = document.getElementById('mc-timer');
    const txt = pad(Math.floor(elapsedSeconds/3600)) + ':' + pad(Math.floor((elapsedSeconds%3600)/60)) + ':' + pad(elapsedSeconds%60);
    if (el) el.textContent = txt;
    if (Live()) Live().timer(txt);
  }
  async function end() {
    // Doble clic en «Finalizar» (página + ventana flotante): un solo cierre.
    if (ending || !active) return;
    ending = true;
    cancelScheduledCoaching();
    if (inflight) supersede();
    // Lo último que se estaba diciendo y Deepgram aún no cerró también va al reporte.
    if (lastInterim && lastInterim.text) { appendToTurn(lastInterim.speaker, lastInterim.text); lastInterim = null; }
    closeTurn();
    // Espera el envío en curso (si lo hay) y manda lo que quedó en la cola.
    for (let i = 0; flushing && i < 40; i++) await new Promise(function (r) { setTimeout(r, 50); });
    await flushChunks();
    cleanup();
    setStatus('ended');
    if (Live()) Live().end();
    const meetId = currentMeetingId;
    currentMeetingId = null;
    active = false;
    ending = false;

    const opts = sessionOpts;
    sessionOpts = {};
    // Return UI to idle state
    if (typeof coachShowIdle === 'function') coachShowIdle();

    if (meetId && opts.stayOnPage) {
      // Llamada del dialer: el reporte queda con la llamada y en la ficha del
      // lead; no se navega a Reportes en medio del trabajo.
      try {
        const final = await global.api.endMeeting({ meeting_id: meetId });
        if (typeof opts.onEnded === 'function') opts.onEnded(meetId, final);
      } catch (e) {
        console.warn('[Coach] endMeeting error:', e);
        if (typeof opts.onEnded === 'function') opts.onEnded(meetId, null);
      }
      return;
    }

    if (meetId) {
      // El reporte se arma en segundo plano: se abre la reunión en Reportes de
      // inmediato, con la transcripción ya visible, y el análisis aparece solo.
      try {
        const final = await global.api.endMeeting({ meeting_id: meetId, background: true });
        if (final && final.pending) toast('Sesión finalizada · Generando el reporte…', 'success');
        else toast('Sesión finalizada · Reporte guardado', 'success');
      } catch (e) {
        console.warn('[Coach] endMeeting error:', e);
        toast('Sesión finalizada. El reporte puede tardar: revísalo en Reportes → Reuniones.', 'warn');
      }
      if (typeof nav === 'function') {
        nav(document.querySelector('[data-page=ventas-reportes]'), 'ventas-reportes');
        if (global.MeetingReport) global.MeetingReport.open(meetId);
      }
    }
  }
  function cleanup() {
    if (workletNode) { try { workletNode.port.onmessage = null; workletNode.disconnect(); } catch(e){} workletNode = null; }
    if (dgRetryTimer) { clearTimeout(dgRetryTimer); dgRetryTimer = null; }
    if (dgKeepAlive) { clearInterval(dgKeepAlive); dgKeepAlive = null; }
    if (audioProcessor) { try { audioProcessor.disconnect(); } catch(e){} audioProcessor = null; }
    if (audioCtx) { try { audioCtx.close(); } catch(e){} audioCtx = null; }
    if (displayStream) { displayStream.getTracks().forEach(function(t){t.stop();}); displayStream = null; }
    // Los tracks de la llamada son del dialer: detenerlos cortaría el audio.
    if (micStream && !callAudio) { micStream.getTracks().forEach(function(t){t.stop();}); }
    micStream = null;
    callAudio = null;
    if (dgSocket) { const sk = dgSocket; dgSocket = null; try { sk.close(); } catch(e){} }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    cancelScheduledCoaching();
    coachPending = false;
    currentProspect = null;
    // Liberar el guard de re-entrancy para permitir reiniciar tras un fallo.
    active = false;
  }
  function esc(s) {
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  global.realtimeCoach = { start: start, end: end, isActive: function() { return active; } };
})(window);
