// js/meeting-coach.js
// ═══════════════════════════════════════════════════════════
// Lógica del AI Sales Coach: lanza el bot, hace polling,
// renderiza transcripción + alertas en tiempo real, y muestra
// indicador "Analizando..." mientras el LLM procesa.
// ═══════════════════════════════════════════════════════════
(function (global) {
  const ui = global.uiHelpers || {};
  const toast = ui.toast || function (msg) { console.log(msg); };

  let pollTimer = null;
  let elapsedTimer = null;
  let currentMeetingId = null;
  let starting = false;       // guard síncrono contra doble-click (currentMeetingId solo se setea tras el await)
  let lastSeenTs = null;
  let elapsedSeconds = 0;
  let lastEventTs = null;     // timestamp del último coaching_event recibido
  let lastChunkTs = null;     // timestamp del último chunk recibido
  let polling = false;        // un poll a la vez: dos con el mismo since_ts duplicaban líneas y alertas
  let ending = false;
  let everSawChunk = false;   // true en cuanto llega el primer chunk — la sesión ya no debe volver a "conectándose"
  const Live = function () { return global.CoachLive || null; };
  // Quién es el vendedor: en modo bot los hablantes traen su nombre real.
  // Los compañeros marcados en «Quién entra de tu empresa» también son vendedores.
  let teamNames = [];
  function isSeller(speaker) {
    const me = String((global.currentProfile && global.currentProfile.full_name) || '').trim().toLowerCase();
    const sp = String(speaker || '').trim().toLowerCase();
    if (!sp) return false;
    const match = function (n) { return !!n && (sp === n || sp.indexOf(n) !== -1 || (sp.length >= 3 && n.indexOf(sp) !== -1)); };
    return sp === 'sdr' || match(me) || teamNames.some(match);
  }

  // ─── INICIO ───────────────────────────────────────────────
  async function start(meetingUrl, prospectContext) {
    if (!meetingUrl || !/^https?:\/\//i.test(meetingUrl)) {
      toast('Link de reunión inválido.', 'error');
      return;
    }
    // Guard de re-entrancy: currentMeetingId solo se setea DESPUÉS del await a
    // startMeeting, así que un doble-click antes de que resuelva creaba dos
    // bots (dos "Predictable AI" en la misma reunión). `starting` se marca síncrono
    // al entrar a la función para cerrar esa ventana.
    if (starting || currentMeetingId) {
      console.warn('[MeetingCoach] Ya hay una sesión activa o iniciándose; ignorando start().');
      return;
    }
    starting = true;
    try {
      const res = await global.api.startMeeting({
        meeting_url: meetingUrl,
        prospect_id: prospectContext && prospectContext.id,
        prospect_name: prospectContext && prospectContext.name,
        context: prospectContext || {}
      });

      currentMeetingId = res.meeting_id;
      teamNames = (Array.isArray(res.team) ? res.team : []).map(function (t) { return String((t && t.name) || '').trim().toLowerCase(); }).filter(Boolean);
      lastSeenTs = null;
      elapsedSeconds = 0;
      lastEventTs = null;
      lastChunkTs = null;
      everSawChunk = false;

      // Limpiar UI de cualquier reunión previa
      clearTranscript();
      clearEvents();
      hideThinking();

      // Fase de apertura y qué decir desde el segundo 0 (js/coach-live.js).
      if (Live()) Live().begin(prospectContext, { status: 'El asistente se está uniendo…', history: res.history });
      setStatus('connecting');
      // 1,2 s: el poll no debe ser el cuello de botella (getMeetingState es barato).
      pollTimer = setInterval(poll, 1200);
      elapsedTimer = setInterval(updateElapsed, 1000);
      if (typeof global.coachShowActive === 'function') {
        global.coachShowActive(prospectContext && prospectContext.name);
      }
      toast('El asistente va entrando a la reunión', 'success');
      if (res.transcript_provider === 'recallai') {
        toast('Transcripción en modo diferido: las alertas pueden tardar minutos. Activa Deepgram (RECALL_TRANSCRIPT_PROVIDER) para tiempo real.', 'warn');
      }
    } catch (e) {
      toast('Error iniciando reunión: ' + e.message, 'error');
    } finally {
      starting = false;
    }
  }

  // ─── POLLING ──────────────────────────────────────────────
  async function poll() {
    // Si la respuesta anterior aún no llegó (función fría, red lenta), este
    // turno se salta: antes dos consultas con el mismo `since_ts` traían los
    // mismos chunks y la transcripción y las alertas salían repetidas.
    if (!currentMeetingId || polling) return;
    polling = true;
    const meetingId = currentMeetingId;
    try {
      const data = await global.api.getMeetingState({
        meeting_id: meetingId,
        since_ts: lastSeenTs
      });
      if (currentMeetingId !== meetingId) return;   // la sesión terminó mientras tanto
      lastSeenTs = data.server_ts;

      if (data.chunks && data.chunks.length) {
        renderTranscript(data.chunks);
        // Capa instantánea: objeción conocida → respuesta base sin esperar al modelo.
        if (Live()) data.chunks.forEach(function (c) { Live().heard(c.speaker, c.text, true, !isSeller(c.speaker)); });
        lastChunkTs = data.chunks[data.chunks.length - 1].ts;
        everSawChunk = true;
      }

      if (data.events && data.events.length) {
        renderEvents(data.events);
        lastEventTs = data.events[data.events.length - 1].ts;
        const latestState = data.events[data.events.length - 1].state;
        if (latestState && latestState.scores) renderScores(latestState.scores);
        hideThinking();
      } else if (data.chunks && data.chunks.length) {
        // Hay texto pero el LLM aún no respondió — mostrar "pensando"
        showThinking();
      }

      // `data.chunks` es solo lo NUEVO desde el último poll (since_ts) — una
      // pausa natural en la conversación no debe hacer que el estado "vuelva"
      // a conectándose. Una vez que llegó el primer chunk, la sesión se
      // considera en vivo por el resto de la reunión.
      setStatus(everSawChunk ? 'live' : 'connecting', !everSawChunk && data.bot_status && data.bot_status.message);
    } catch (e) {
      console.warn('Poll error', e);
    } finally {
      polling = false;
    }
  }

  // ─── RENDER TRANSCRIPCIÓN ─────────────────────────────────
  function renderTranscript(chunks) {
    const c = document.getElementById('mc-transcript');
    if (c) {
      const stick = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
      chunks.forEach(function (chunk) {
        const div = document.createElement('div');
        div.className = 'mc-tr-row notranslate' + (isSeller(chunk.speaker) ? ' is-sdr' : ' is-lead');
        const who = document.createElement('span');
        who.className = 'mc-tr-who';
        who.textContent = chunk.speaker + ':';
        const what = document.createElement('span');
        what.className = 'mc-tr-text';
        what.textContent = chunk.text;
        div.appendChild(who); div.appendChild(document.createTextNode(' ')); div.appendChild(what);
        c.appendChild(div);
      });
      if (stick) c.scrollTop = c.scrollHeight;
    }
    // El subtítulo en vivo lo pinta CoachLive.heard() (js/coach-live.js).
  }

  function clearTranscript() {
    const c = document.getElementById('mc-transcript');
    if (c) c.textContent = '';
  }

  // ─── RENDER EVENTOS ───────────────────────────────────────
  function renderEvents(events) {
    const c = document.getElementById('mc-events');
    if (!c) return;
    events.forEach(function (ev) {
      (ev.alerts || []).forEach(function (a) {
        if (Live()) Live().showAlert(a); else c.prepend(buildAlert(a));
      });
      // Fase, frase a decir y orden: en la página y en la ventana flotante.
      if (Live()) {
        Live().coach({
          alerts: ev.alerts || [],
          stage: (ev.state && ev.state.stage) || '',
          next_step: (ev.next_steps && ev.next_steps[0]) || '',
        });
      } else if (ev.next_steps && ev.next_steps.length) {
        renderNextSteps(ev.next_steps, ev.state && ev.state.stage);
      }
    });
  }

  function clearEvents() {
    const c = document.getElementById('mc-events');
    if (!c) return;
    // Limpiar solo cards de alerta dinámicas, NO los cards estáticos (score / etapa)
    Array.from(c.querySelectorAll('.ai-alert-dynamic')).forEach(function (el) { el.remove(); });
    const empty = document.getElementById('mc-events-empty');
    if (empty) empty.style.display = '';
  }

  function buildAlert(alert) {
    const card = document.createElement('div');
    card.className = 'ai-suggestion ai-alert-dynamic';
    const colors = {
      objection: 'var(--amber)',
      positive_signal: 'var(--green)',
      risk: 'var(--red)',
      stage_guidance: 'var(--gold)'
    };
    const color = colors[alert.type] || 'var(--teal)';
    card.style.cssText = 'border:2px solid ' + color + ';background:rgba(245,158,11,.06)';

    let html =
      '<div class="ai-tag" style="color:' + color + '">' +
        esc(alert.title || alert.type.toUpperCase()) +
      '</div>' +
      '<div class="ai-text">' + esc(alert.explanation || '') + '</div>';

    if (alert.suggested_phrase) {
      const phrase = esc(alert.suggested_phrase);
      html +=
        '<div style="background:var(--surface2);border-radius:6px;padding:10px;' +
          'margin-top:8px;font-size:12px;line-height:1.7">' +
          '<strong style="color:' + color + '">Di esto:</strong><br>' + phrase +
        '</div>' +
        '<button class="ai-copy" data-phrase="' + phrase + '" ' +
          'onclick="navigator.clipboard.writeText(this.dataset.phrase); this.textContent=\'✓ Copiado\'">' +
          '📋 Copiar' +
        '</button>';
    }
    card.innerHTML = html;
    return card;
  }

  // ─── INDICADOR "PENSANDO" ─────────────────────────────────
  // Señal discreta junto a la frase (antes, una tarjeta que entraba y salía
  // de la lista de alertas en cada consulta).
  function showThinking() { if (Live()) Live().thinking(true); }
  function hideThinking() { if (Live()) Live().thinking(false); }

  // ─── SCORES ───────────────────────────────────────────────
  function renderScores(scores) {
    if (!scores) return;
    // La tarjeta solo existe cuando hay puntajes reales (modo asistente).
    const card = document.getElementById('mc-scores-card');
    if (card) card.style.display = '';
    const map = {
      'mc-score-listening': scores.active_listening,
      'mc-score-pain': scores.pain_deepening,
      'mc-score-pace': scores.pace_control,
      'mc-score-objection': scores.objection_handling
    };
    Object.keys(map).forEach(function (id) {
      const v = map[id];
      if (v == null) return;
      const el = document.getElementById(id);
      if (!el) return;
      const num = el.querySelector('.score-num');
      const fill = el.querySelector('.score-fill');
      if (num) num.textContent = v + '%';
      if (fill) fill.style.width = v + '%';
    });
  }

  // ─── NEXT STEPS / ETAPA ───────────────────────────────────
  function renderNextSteps(steps, stage) {
    const c = document.getElementById('mc-next-steps');
    if (c) {
      c.innerHTML = steps.map(function (s, i) {
        return '<div style="font-size:12px;padding:6px 8px;' +
          'background:var(--surface2);border-radius:6px">' +
          (i + 1) + '. ' + esc(s) +
          '</div>';
      }).join('');
    }
    const stEl = document.getElementById('mc-stage');
    if (stEl && stage) stEl.textContent = stage.charAt(0).toUpperCase() + stage.slice(1);
  }

  // ─── STATUS / TIMER ───────────────────────────────────────
  function setStatus(status, override) {
    const el = document.getElementById('mc-status');
    if (!el) return;
    if (Live() && status !== 'ended') Live().status(override || (status === 'live' ? 'Transcribiendo en vivo' : 'El asistente se está uniendo…'));
    if (override) { el.textContent = override; return; }
    el.textContent = ({
      connecting: 'El asistente se está uniendo…',
      live: 'Transcribiendo en vivo',
      ended: 'Reunión finalizada'
    })[status] || status;
  }

  function updateElapsed() {
    elapsedSeconds++;
    const h = Math.floor(elapsedSeconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((elapsedSeconds % 3600) / 60).toString().padStart(2, '0');
    const s = (elapsedSeconds % 60).toString().padStart(2, '0');
    const el = document.getElementById('mc-timer');
    if (el) el.textContent = h + ':' + m + ':' + s;
    if (Live()) Live().timer(h + ':' + m + ':' + s);
  }

  // ─── FINALIZAR ────────────────────────────────────────────
  async function end() {
    if (!currentMeetingId || ending) return;
    ending = true;
    clearInterval(pollTimer);
    clearInterval(elapsedTimer);
    hideThinking();
    const meetId = currentMeetingId;
    currentMeetingId = null;
    setStatus('ended');
    if (typeof global.coachShowIdle === 'function') global.coachShowIdle();
    const urlInput = document.getElementById('mc-meeting-url');
    if (urlInput) urlInput.value = '';
    if (Live()) Live().end();
    // El reporte se arma en segundo plano: se abre la reunión en Reportes de
    // inmediato y el análisis aparece solo (la transcripción de Recall puede
    // tardar unos minutos en modo bot).
    try {
      await global.api.endMeeting({ meeting_id: meetId, background: true });
      toast('Reunión finalizada · Generando el reporte…', 'success');
    } catch (e) {
      toast('Error finalizando: ' + e.message, 'error');
    }
    if (typeof nav === 'function') {
      nav(document.querySelector('[data-page=ventas-reportes]'), 'ventas-reportes');
      if (global.MeetingReport) global.MeetingReport.open(meetId);
    }
    ending = false;
  }

  // ─── HELPERS ──────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // API pública del módulo
  global.meetingCoach = { start: start, end: end, isActive: function () { return !!currentMeetingId; } };
})(window);
