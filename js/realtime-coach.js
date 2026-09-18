// js/realtime-coach.js
// ═══════════════════════════════════════════════════════════
// Real-Time Coach v3 — Grant Token de Deepgram.
// Worker da un token temporal (10 min). Cliente conecta DIRECTO
// a Deepgram con ese token. Sin WebSocket relay = sin bugs.
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
  let recentTranscript = [];    // últimos turnos {speaker, text, ts, el}
  let pendingTurn = null;       // turno abierto: sigue recibiendo chunks del mismo hablante
  let totalTurns = 0;
  let totalWords = 0;
  let turnsAtLastCoach = 0;
  let wordsAtLastCoach = 0;
  let shownAlerts = [];         // {key, phrase, ts} de alertas ya mostradas
  let active = false;

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
  async function start(prospectContext) {
    if (!cfg.WORKER_URL) {
      toast('WORKER_URL no configurado en js/config.js', 'error'); return;
    }
    // Sin lead no hay sesión: el reporte, el brief y el contexto del coach
    // dependen del contacto elegido en el selector del Meeting Coach.
    if (!prospectContext || !(prospectContext.id || prospectContext.name)) {
      toast('Selecciona el lead de esta reunión antes de iniciar el coach.', 'warn');
      return;
    }
    // Guard de re-entrancy: un segundo start() sin cerrar el anterior filtra
    // el timer, el WebSocket y los tracks de mic/pantalla.
    if (active) { console.warn('[Coach] Ya hay una sesión activa; ignorando start().'); return; }
    active = true;
    try {
      console.log('[Coach] 1/4 Pidiendo token a Deepgram via Worker...');
      const dgToken = await getDeepgramToken();

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

      // El navegador no permite FORZAR la superficie: validar lo elegido.
      // Una pestaña o ventana deja de oírse en cuanto el cliente cambia de
      // app/tab — solo pantalla completa garantiza capturar toda la reunión.
      const vTrack = displayStream.getVideoTracks()[0];
      const surface = (vTrack && typeof vTrack.getSettings === 'function')
        ? vTrack.getSettings().displaySurface : null;
      if (surface && surface !== 'monitor') {
        cleanup();
        toast('Compartiste una ' + (surface === 'browser' ? 'pestaña' : 'ventana') +
          '. Comparte la pantalla completa para que el coach escuche toda la reunión.', 'error');
        if (typeof coachShowIdle === 'function') coachShowIdle();
        return;
      }

      if (displayStream.getAudioTracks().length === 0) {
        cleanup();
        toast('No se captó el audio de la reunión. Al compartir la pantalla completa, ' +
          'marca "Compartir audio del sistema" (requiere Chrome/Edge/Arc actualizado).', 'error');
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

      console.log('[Coach] 4/4 Registrando meeting...');
      const res = await global.api.startMeeting({
        meeting_url: 'local-capture://realtime',
        prospect_id: prospectContext && prospectContext.id,
        prospect_name: prospectContext && prospectContext.name,
        context: prospectContext || {},
        mode: 'live'
      });
      currentMeetingId = res.meeting_id;
      active = true;

      clearUI();
      setStatus('connecting');
      elapsedSeconds = 0;
      elapsedTimer = setInterval(updateElapsed, 1000);

      // Switch UI to active state
      if (typeof coachShowActive === 'function') {
        coachShowActive(prospectContext && prospectContext.name);
      }

      // ─── CONECTAR DIRECTO A DEEPGRAM CON TOKEN TEMPORAL ─
      connectDeepgramDirect(dgToken);
      startAudioCapture();

      displayStream.getVideoTracks()[0].onended = function () {
        toast('Captura detenida', 'warn'); end();
      };
      toast('Coach en vivo iniciado', 'success');
    } catch (e) {
      console.error('[Coach] Start error:', e);
      toast('Error iniciando coach: ' + e.message, 'error');
      cleanup();
      if (typeof coachShowIdle === 'function') coachShowIdle();
    }
  }

  function startAudioCapture() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      console.log('[Coach] AudioContext sampleRate:', audioCtx.sampleRate, 'state:', audioCtx.state);

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

      const tabAudio = new MediaStream(displayStream.getAudioTracks());
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

      audioProcessor = audioCtx.createScriptProcessor(4096, 2, 2);
      let frameCount = 0;
      audioProcessor.onaudioprocess = function (e) {
        if (!dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
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
        dgSocket.send(interleaved.buffer);
        frameCount++;
        if (frameCount === 1) console.log('[Coach] Primer frame de audio stereo enviado (L=Lead, R=SDR)');
        if (frameCount % 100 === 0) console.log('[Coach] Frames enviados:', frameCount);
      };

      merger.connect(audioProcessor);
      audioProcessor.connect(audioCtx.destination);
      console.log('[Coach] Audio capture dual iniciada');

      // Watchdog: si a los 8s no salió ni un frame de audio, avisar en la UI
      // en lugar de dejar la sesión "escuchando" en silencio indefinidamente.
      setTimeout(function () {
        if (active && frameCount === 0) {
          toast('No está llegando audio al coach. Verifica que marcaste "Compartir audio ' +
            'del sistema" y el permiso del micrófono, y reinicia la sesión.', 'error');
        }
      }, 8000);
    } catch (e) {
      console.error('[Coach] AudioContext error:', e);
      toast('Error de audio: ' + e.message, 'error');
    }
  }

  // ─── DEEPGRAM DIRECTO (con token temporal) ─────────────────
  function connectDeepgramDirect(accessToken) {
    // STEREO + multichannel para separar SDR (canal 1) y Lead (canal 0)
    const params = [
      'model=nova-2', 'language=multi',
      'interim_results=true', 'endpointing=300',
      'utterance_end_ms=1000', 'smart_format=true', 'punctuate=true',
      'encoding=linear16', 'sample_rate=16000', 'channels=2', 'multichannel=true'
    ].join('&');

    // JWT Grant Token: probamos primero como subprotocol bearer (forma correcta)
    const url = 'wss://api.deepgram.com/v1/listen?' + params;
    console.log('[Coach] URL Deepgram:', url);
    console.log('[Coach] Token (primeros 30 chars):', accessToken.substring(0, 30) + '...');
    // Pasar JWT como Bearer en subprotocol
    dgSocket = new WebSocket(url, ['bearer', accessToken]);

    dgSocket.onopen = function () {
      console.log('[Coach] Deepgram WS abierto ✓');
      setStatus('live');
    };
    dgSocket.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'Results') handleTranscript(msg);
        else if (msg.type === 'UtteranceEnd') handleUtteranceEnd();
        else if (msg.type === 'Metadata') console.log('[Coach] Deepgram metadata:', msg);
      } catch (e) { console.warn('[Coach] DG parse error', e); }
    };
    dgSocket.onerror = function (e) {
      console.error('[Coach] Deepgram error:', e);
      toast('Error de Deepgram', 'error');
    };
    dgSocket.onclose = function (e) {
      console.log('[Coach] Deepgram cerrado:', e.code, e.reason || '(sin razón)', 'wasClean:', e.wasClean);
      if (!e.wasClean && (e.code === 1011 || e.code === 1006 || e.code === 1002)) {
        toast('Deepgram rechazó conexión (' + e.code + '). Revisa consola para detalles.', 'error');
      }
    };
  }

  function handleTranscript(msg) {
    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    if (!alt || !alt.transcript) return;
    const text = alt.transcript.trim();
    if (!text) return;

    const channelIdx = (msg.channel_index && msg.channel_index[0]) || 0;
    const speaker = channelIdx === 1 ? 'SDR' : 'Lead';
    const isFinal = msg.is_final;
    showInterim(speaker, text, isFinal);

    // Alguien sigue hablando: el coach espera a que termine el mensaje.
    cancelScheduledCoaching();
    if (isFinal) {
      appendToTurn(speaker, text);
      if (msg.speech_final) scheduleCoaching();
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
    totalWords += text.split(/\s+/).filter(Boolean).length;
    renderTurn(pendingTurn);
  }

  function closeTurn() {
    if (!pendingTurn) return;
    enqueueChunkForBackend({ speaker: pendingTurn.speaker, text: pendingTurn.text, ts: pendingTurn.ts });
    pendingTurn = null;
  }

  // UtteranceEnd llega `utterance_end_ms` después de la última palabra (y por
  // canal, así que puede llegar dos veces). Encima esperamos COACH_SILENCE_MS
  // más: si el hablante retoma, cualquier resultado nuevo cancela el timer.
  function handleUtteranceEnd() { scheduleCoaching(); }

  function scheduleCoaching() {
    cancelScheduledCoaching();
    coachTimer = setTimeout(function () {
      coachTimer = null;
      maybeRunCoaching();
    }, cfg.COACH_SILENCE_MS || 1200);
  }
  function cancelScheduledCoaching() {
    if (coachTimer) { clearTimeout(coachTimer); coachTimer = null; }
  }

  function maybeRunCoaching() {
    if (!active) return;
    if (coachInFlight) { coachPending = true; return; }
    // Sin contenido nuevo suficiente ("ok", "sí") no hay nada que analizar.
    const minWords = cfg.COACH_MIN_NEW_WORDS || 6;
    if (totalWords - wordsAtLastCoach < minWords) return;
    runCoaching();
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

    // Ventana de contexto = últimos 15 turnos, separando lo que el coach ya
    // vio de lo nuevo: las alertas deben salir SOLO de lo nuevo. Los
    // contadores se mueven antes de la llamada para que lo que llegue
    // mientras el modelo responde cuente como nuevo en el siguiente turno.
    const windowTurns = recentTranscript.slice(-15);
    const newCount = Math.min(windowTurns.length, totalTurns - turnsAtLastCoach);
    const prior = windowTurns.slice(0, windowTurns.length - newCount).map(formatTurn).join('\n');
    const fresh = windowTurns.slice(windowTurns.length - newCount).map(formatTurn).join('\n');
    const context = windowTurns.map(formatTurn).join('\n');
    const prevTurns = turnsAtLastCoach, prevWords = wordsAtLastCoach;
    turnsAtLastCoach = totalTurns;
    wordsAtLastCoach = totalWords;

    function onFailure(e) {
      console.error('Coaching error', e);
      hideThinking();
      // Que lo nuevo se reintente en el siguiente silencio.
      turnsAtLastCoach = prevTurns; wordsAtLastCoach = prevWords;
    }
    function onSuccess(parsed) {
      hideThinking();
      const shown = renderCoachOutput(parsed || {});
      enqueueEventForBackend(shown);
    }
    function done() {
      coachInFlight = false;
      if (coachPending && active) scheduleCoaching();
    }

    if (coachEngine() !== 'openai') {
      try {
        const parsed = await global.api.coachTurn({
          meeting_id: currentMeetingId,
          transcript: context,
          prior_transcript: prior,
          new_transcript: fresh,
          context: currentProspect || {},
        });
        onSuccess(parsed);
      } catch (e) {
        onFailure(e);
      } finally { done(); }
      return;
    }

    // Espejo corto de NEURO_DOCTRINE (supabase/functions/sales-coach/index.ts):
    // este camino solo corre cuando el motor es OpenAI vía el worker.
    const systemPrompt = [
      'Eres el coach de ventas de Predictable.ai en vivo, al oído del vendedor durante una llamada B2B.',
      'Hablas como un entrenador de neuroventas de la escuela de Jürgen Klarić: directo, frases cortas, sin teoría.',
      'Véndele a la mente: primero el cerebro reptil (miedo a perder, seguridad, poder, ahorrar tiempo), luego la emoción, al final los datos.',
      'Objeciones en 3 movimientos: valida la emoción, reencuadra al miedo/deseo del lead, pregunta que lleva a un sí pequeño. Nunca pelees con su proveedor actual.',
      'Cada dato del lead (dolor, meta, plazo, presupuesto, decisor) es una puerta: si el vendedor la deja pasar, dile la pregunta exacta para abrirla.',
      'Si el vendedor habla más del 60 %, ordénale callarse y preguntar. Sin siguiente paso con fecha no hay cierre.',
      'La conversación tiene 2 hablantes: "Lead" y "SDR" (el vendedor).',
      'Recibes la parte de la conversación que ya analizaste (solo contexto) y lo NUEVO.',
      'Genera alertas SOLO sobre lo nuevo; no repitas alertas de la parte anterior.',
      '"suggested_phrase" es la frase exacta que el vendedor puede decir AHORA. "next_step" es la orden para este instante, en imperativo, una frase; siempre trae una.',
      'OUTPUT: SOLO JSON con schema:',
      '{',
      '  "alerts": [{ "type":"objection|positive_signal|risk|stage_guidance", "title":"", "explanation":"", "suggested_phrase":"" }],',
      '  "stage": "rapport|discovery|reframe|demo|negotiation|close",',
      '  "next_step": ""',
      '}',
      'Español neutro. NO inventes alertas: si no hay nada accionable, "alerts": [].'
    ].join('\n');
    const userContent = 'Contexto del prospecto (brief del lead, ángulo y preparación):\n' + JSON.stringify(currentProspect || {}).slice(0, 4000) + '\n\n' +
      (prior ? 'Conversación anterior (ya analizada, solo contexto):\n' + prior + '\n\n' : '') +
      'Lo nuevo (analiza solo esto):\n' + fresh;

    try {
      const resp = await fetch(workerUrl('/openai'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.LLM_MODEL || 'gpt-4o-mini',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ]
        })
      });
      if (!resp.ok) throw new Error('OpenAI ' + resp.status + ': ' + await resp.text());
      const data = await resp.json();
      const content = data.choices && data.choices[0] && data.choices[0].message.content;
      if (!content) throw new Error('vacío');
      onSuccess(JSON.parse(content));
    } catch (e) {
      onFailure(e);
    } finally { done(); }
  }

  // ─── Persistencia, UI, end(), cleanup() ────────────────────
  function enqueueChunkForBackend(c) { chunkQueue.push(c); if (chunkQueue.length >= 3) flushChunks(); }
  async function flushChunks() {
    if (!currentMeetingId || chunkQueue.length === 0) return;
    const batch = chunkQueue.splice(0);
    try { await global.api.ingestLocalChunks({ meeting_id: currentMeetingId, chunks: batch }); }
    catch (e) { chunkQueue = batch.concat(chunkQueue); }
  }
  async function enqueueEventForBackend(ev) {
    if (!currentMeetingId) return;
    try { await global.api.ingestLocalEvent({ meeting_id: currentMeetingId, event: ev }); } catch (e) {}
  }

  function clearUI() {
    cancelScheduledCoaching();
    pendingTurn = null; recentTranscript = []; shownAlerts = [];
    totalTurns = 0; totalWords = 0; turnsAtLastCoach = 0; wordsAtLastCoach = 0;
    coachPending = false;
    const t = document.getElementById('mc-transcript'); if (t) t.innerHTML = '';
    const e = document.getElementById('mc-events');
    if (e) Array.from(e.querySelectorAll('.ai-alert-dynamic')).forEach(function (el) { el.remove(); });
    hideThinking();
  }
  function showInterim(speaker, text, isFinal) {
    const el = document.getElementById('mc-last-spoken'); if (!el) return;
    const color = speaker === 'SDR' ? 'var(--green)' : 'var(--teal)';
    el.innerHTML =
      '<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">' +
      (isFinal ? 'Lo último que se dijo' : 'Escuchando...') + '</div>' +
      '<div style="font-size:15px;color:' + (isFinal ? 'var(--text)' : 'var(--text3)') +
      ';line-height:1.5;font-style:' + (isFinal ? 'normal' : 'italic') + '">' +
      '<strong style="color:' + color + '">' + esc(speaker) + ':</strong> ' + esc(text) + '</div>';
  }
  // Una línea por turno: mientras el hablante sigue, la misma línea crece.
  function renderTurn(turn) {
    const c = document.getElementById('mc-transcript'); if (!c) return;
    if (!turn.el) {
      const color = turn.speaker === 'SDR' ? 'var(--green)' : 'var(--teal)';
      const div = document.createElement('div');
      const who = document.createElement('span');
      who.style.cssText = 'color:' + color + ';font-weight:700';
      who.textContent = turn.speaker + ':';
      const what = document.createElement('span');
      what.style.color = 'var(--text2)';
      div.appendChild(who); div.appendChild(document.createTextNode(' ')); div.appendChild(what);
      c.appendChild(div);
      turn.el = what;
    }
    turn.el.textContent = turn.text;
    c.scrollTop = c.scrollHeight;
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
  function renderCoachOutput(out) {
    const alerts = (out.alerts || []).filter(function (a) {
      if (!a || typeof a !== 'object' || isDuplicateAlert(a)) return false;
      shownAlerts.push({ key: alertKey(a), phrase: String(a.suggested_phrase || '').trim().toLowerCase(), ts: Date.now() });
      return true;
    });
    const events = document.getElementById('mc-events');
    if (events) alerts.forEach(function (a) { events.prepend(buildAlertCard(a)); });
    if (out.stage) { const stEl = document.getElementById('mc-stage'); if (stEl) stEl.textContent = out.stage.charAt(0).toUpperCase() + out.stage.slice(1); }
    if (out.next_step) { const ns = document.getElementById('mc-next-steps'); if (ns) ns.innerHTML = '<div style="font-size:12px;padding:6px 8px;background:var(--surface2);border-radius:6px">' + esc(out.next_step) + '</div>'; }
    return { alerts: alerts, stage: out.stage || '', next_step: out.next_step || '' };
  }
  function buildAlertCard(alert) {
    const card = document.createElement('div');
    card.className = 'ai-suggestion ai-alert-dynamic';
    const colors = { objection: 'var(--amber)', positive_signal: 'var(--green)', risk: 'var(--red)', stage_guidance: 'var(--gold)' };
    const color = colors[alert.type] || 'var(--teal)';
    card.style.cssText = 'border:2px solid ' + color + ';background:rgba(245,158,11,.06)';
    let html = '<div class="ai-tag" style="color:' + color + '">' + esc(alert.title || alert.type.toUpperCase()) + '</div>' +
               '<div class="ai-text">' + esc(alert.explanation || '') + '</div>';
    if (alert.suggested_phrase) {
      const phrase = esc(alert.suggested_phrase);
      html += '<div style="background:var(--surface2);border-radius:6px;padding:10px;margin-top:8px;font-size:12px;line-height:1.7"><strong style="color:' + color + '">Di esto:</strong><br>' + phrase + '</div>';
    }
    card.innerHTML = html;
    return card;
  }
  function showThinking() {
    if (document.getElementById('mc-thinking')) return;
    const el = document.createElement('div');
    el.id = 'mc-thinking'; el.className = 'ai-suggestion ai-alert-dynamic';
    el.style.cssText = 'border:1px dashed var(--teal);background:rgba(0,196,212,.05);animation:pulse 1.5s infinite';
    el.innerHTML = '<div class="ai-tag" style="color:var(--teal)">🧠 PROCESANDO</div>';
    const events = document.getElementById('mc-events'); if (events) events.prepend(el);
  }
  function hideThinking() { const el = document.getElementById('mc-thinking'); if (el) el.remove(); }
  function setStatus(s) {
    const el = document.getElementById('mc-status'); if (!el) return;
    const map = { connecting: 'Conectando...', live: '🎙 Escuchando (tú + lead)', ended: 'Sesión finalizada' };
    el.textContent = map[s] || s;
  }
  function updateElapsed() {
    elapsedSeconds++;
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const el = document.getElementById('mc-timer');
    if (el) el.textContent = pad(Math.floor(elapsedSeconds/3600)) + ':' + pad(Math.floor((elapsedSeconds%3600)/60)) + ':' + pad(elapsedSeconds%60);
  }
  async function end() {
    cancelScheduledCoaching();
    closeTurn();
    await flushChunks();
    cleanup();
    setStatus('ended');
    const meetId = currentMeetingId;
    currentMeetingId = null;
    active = false;

    // Return UI to idle state
    if (typeof coachShowIdle === 'function') coachShowIdle();

    if (meetId) {
      try {
        const final = await global.api.endMeeting({ meeting_id: meetId });
        if (final && final.pending) {
          toast('Sesión finalizada · Generando el reporte…', 'success');
        } else {
          toast('Sesión finalizada · Score: ' + ((final && final.score_total) || 0) + ' · Reporte guardado', 'success');
        }
        // Navigate to reports → last meeting tab
        setTimeout(function () {
          if (typeof nav === 'function') {
            nav(document.querySelector('[data-page=ventas-reportes]'), 'ventas-reportes');
            const lastMeetingTab = document.querySelector('#page-ventas-reportes .tab[onclick*="rep-meeting"]');
            if (lastMeetingTab && typeof switchReportTab === 'function') switchReportTab(lastMeetingTab, 'rep-meeting');
          }
        }, 1000);
      } catch (e) {
        console.warn('[Coach] endMeeting error:', e);
        toast('Sesión finalizada · Reporte guardado localmente', 'success');
      }
    }
  }
  function cleanup() {
    if (audioProcessor) { try { audioProcessor.disconnect(); } catch(e){} audioProcessor = null; }
    if (audioCtx) { try { audioCtx.close(); } catch(e){} audioCtx = null; }
    if (displayStream) { displayStream.getTracks().forEach(function(t){t.stop();}); displayStream = null; }
    if (micStream) { micStream.getTracks().forEach(function(t){t.stop();}); micStream = null; }
    if (dgSocket) { try { dgSocket.close(); } catch(e){} dgSocket = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    cancelScheduledCoaching();
    coachPending = false;
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
