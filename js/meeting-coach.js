// js/meeting-coach.js
// ═══════════════════════════════════════════════════════════
// Lógica del Meeting Coach: lanza el bot, hace polling,
// renderiza transcripción + alertas en tiempo real, y muestra
// indicador "Analizando..." mientras el LLM procesa.
// ═══════════════════════════════════════════════════════════
(function (global) {
  const ui = global.uiHelpers || {};
  const toast = ui.toast || function (msg) { console.log(msg); };

  let pollTimer = null;
  let elapsedTimer = null;
  let currentMeetingId = null;
  let lastSeenTs = null;
  let elapsedSeconds = 0;
  let lastEventTs = null;     // timestamp del último coaching_event recibido
  let lastChunkTs = null;     // timestamp del último chunk recibido

  // ─── INICIO ───────────────────────────────────────────────
  async function start(meetingUrl, prospectContext) {
    if (!meetingUrl || !/^https?:\/\//i.test(meetingUrl)) {
      toast('Link de reunión inválido.', 'error');
      return;
    }
    // Guard de re-entrancy: un segundo start() sin cerrar el anterior filtra
    // los timers de polling.
    if (currentMeetingId) { console.warn('[MeetingCoach] Ya hay una sesión activa; ignorando start().'); return; }
    try {
      const res = await global.api.startMeeting({
        meeting_url: meetingUrl,
        prospect_id: prospectContext && prospectContext.id,
        prospect_name: prospectContext && prospectContext.name,
        context: prospectContext || {}
      });

      currentMeetingId = res.meeting_id;
      lastSeenTs = null;
      elapsedSeconds = 0;
      lastEventTs = null;
      lastChunkTs = null;

      // Limpiar UI de cualquier reunión previa
      clearTranscript();
      clearEvents();
      hideThinking();

      setStatus('connecting');
      pollTimer = setInterval(poll, 4000);
      elapsedTimer = setInterval(updateElapsed, 1000);
      if (typeof global.coachShowActive === 'function') {
        global.coachShowActive(prospectContext && prospectContext.name);
      }
      toast('Bot lanzado a la reunión', 'success');
    } catch (e) {
      toast('Error iniciando reunión: ' + e.message, 'error');
    }
  }

  // ─── POLLING ──────────────────────────────────────────────
  async function poll() {
    if (!currentMeetingId) return;
    try {
      const data = await global.api.getMeetingState({
        meeting_id: currentMeetingId,
        since_ts: lastSeenTs
      });
      lastSeenTs = data.server_ts;

      if (data.chunks && data.chunks.length) {
        renderTranscript(data.chunks);
        lastChunkTs = data.chunks[data.chunks.length - 1].ts;
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

      const hasChunks = data.chunks && data.chunks.length;
      setStatus(hasChunks ? 'live' : 'connecting', !hasChunks && data.bot_status && data.bot_status.message);
    } catch (e) {
      console.warn('Poll error', e);
    }
  }

  // ─── RENDER TRANSCRIPCIÓN ─────────────────────────────────
  function renderTranscript(chunks) {
    const c = document.getElementById('mc-transcript');
    if (c) {
      chunks.forEach(function (chunk) {
        const div = document.createElement('div');
        div.innerHTML =
          '<span style="color:var(--teal);font-weight:700">' + esc(chunk.speaker) + ':</span> ' +
          '<span style="color:var(--text2)">' + esc(chunk.text) + '</span>';
        c.appendChild(div);
      });
      c.scrollTop = c.scrollHeight;
    }
    const last = chunks[chunks.length - 1];
    const heroEl = document.getElementById('mc-last-spoken');
    if (last && heroEl) {
      heroEl.innerHTML =
        '<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Lo último que se dijo</div>' +
        '<div style="font-size:15px;color:var(--text);line-height:1.5">' +
        '<strong style="color:var(--teal)">' + esc(last.speaker) + ':</strong> ' + esc(last.text) + '</div>';
    }
  }

  function clearTranscript() {
    const c = document.getElementById('mc-transcript');
    if (c) c.innerHTML = '';
  }

  // ─── RENDER EVENTOS ───────────────────────────────────────
  function renderEvents(events) {
    const c = document.getElementById('mc-events');
    if (!c) return;
    events.forEach(function (ev) {
      (ev.alerts || []).forEach(function (a) { c.prepend(buildAlert(a)); });
      if (ev.next_steps && ev.next_steps.length) {
        renderNextSteps(ev.next_steps, ev.state && ev.state.stage);
      }
    });
  }

  function clearEvents() {
    const c = document.getElementById('mc-events');
    if (!c) return;
    // Limpiar solo cards de alerta dinámicas, NO los cards estáticos (score / etapa)
    Array.from(c.querySelectorAll('.ai-alert-dynamic')).forEach(function (el) { el.remove(); });
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
  function showThinking() {
    if (document.getElementById('mc-thinking')) return;
    const el = document.createElement('div');
    el.id = 'mc-thinking';
    el.className = 'ai-suggestion ai-alert-dynamic';
    el.style.cssText =
      'border:1px dashed var(--teal);background:rgba(0,196,212,.05);' +
      'animation:pulse 1.5s infinite';
    el.innerHTML =
      '<div class="ai-tag" style="color:var(--teal)">🧠 ANALIZANDO LO ÚLTIMO QUE SE DIJO</div>' +
      '<div class="ai-text" style="font-size:11px;color:var(--text3)">' +
        'El coach está procesando la conversación...</div>';
    const events = document.getElementById('mc-events');
    if (events) events.prepend(el);
  }
  function hideThinking() {
    const el = document.getElementById('mc-thinking');
    if (el) el.remove();
  }

  // ─── SCORES ───────────────────────────────────────────────
  function renderScores(scores) {
    if (!scores) return;
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
    if (override) { el.textContent = override; return; }
    el.textContent = ({
      connecting: 'Bot conectándose...',
      live: '● Transcribiendo en vivo',
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
  }

  // ─── FINALIZAR ────────────────────────────────────────────
  async function end() {
    if (!currentMeetingId) return;
    clearInterval(pollTimer);
    clearInterval(elapsedTimer);
    hideThinking();
    const meetId = currentMeetingId;
    currentMeetingId = null;
    setStatus('ended');
    if (typeof global.coachShowIdle === 'function') global.coachShowIdle();
    const urlInput = document.getElementById('mc-meeting-url');
    if (urlInput) urlInput.value = '';
    try {
      const final = await global.api.endMeeting({ meeting_id: meetId });
      toast('Reunión finalizada — score: ' + (final.score_total || 0), 'success');
      setTimeout(function () {
        if (typeof nav === 'function') {
          nav(document.querySelector('[data-page=ventas-reportes]'), 'ventas-reportes');
        }
      }, 800);
    } catch (e) {
      toast('Error finalizando: ' + e.message, 'error');
    }
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
