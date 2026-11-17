// js/coach-research.js
// ═══════════════════════════════════════════════════════════
// «Investigación con IA» en el panel «Lo que sabes del lead» del AI Sales
// Coach (2026-11-17, pedido del dueño). Por cada persona de la reunión (un
// lead o todos los de una lista): estado, botón «Investigar con IA» y el
// resultado.
//
// Es BILATERAL con Listas: usa la misma edge function `lead-research` y se
// guarda en la misma fila (prospect_list_members.research), así lo que se
// investiga aquí aparece en Listas → Investigación y lo investigado allá
// aparece aquí. Desde el coach se pide con `purpose: 'meeting'`: el ángulo y
// las preguntas se orientan a la reunión según el Entrenamiento IA del equipo.
// El resultado entra al contexto del coach (`research`, decisión del dueño del
// 2026-11-17 que revierte la del 2026-11-16).
// ═══════════════════════════════════════════════════════════
(function (global) {
  const running = new Set();   // member ids investigándose desde esta pestaña
  let lastCtx = null;

  function pd() { return global.prospectingData; }
  function esc(s) {
    if (global.escHtml) return global.escHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      if (global.i18n && global.i18n.formatDate) return global.i18n.formatDate(iso, { day: 'numeric', month: 'short' });
      return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    } catch (_) { return ''; }
  }

  // Personas de la reunión: los participantes de la lista o el lead solo.
  function peopleOf(ctx) {
    if (!ctx) return [];
    if (ctx.group && Array.isArray(ctx.participants)) return ctx.participants;
    return ctx.id ? [{ id: ctx.id, name: ctx.name, research_state: ctx.research_state, research_at: ctx.research_at, research: ctx.research }] : [];
  }

  function stateOf(p) {
    if (running.has(String(p.id))) return 'running';
    return p.research_state || 'none';
  }

  function chip(state, at) {
    if (state === 'running') return '<span class="mcr-chip mcr-run">Investigando…</span>';
    if (state === 'ready') return '<span class="mcr-chip mcr-ok">' + (at ? 'Investigado el ' + esc(fmtDate(at)) : 'Investigado') + '</span>';
    if (state === 'error') return '<span class="mcr-chip mcr-err">No se pudo investigar</span>';
    return '<span class="mcr-chip">Sin investigar</span>';
  }

  function render(ctx) {
    lastCtx = ctx || null;
    const host = document.getElementById('mc-brief-research');
    const sec = document.getElementById('mc-brief-research-sec');
    if (!host || !sec) return;
    const people = peopleOf(ctx);
    if (!people.length) { sec.style.display = 'none'; host.innerHTML = ''; return; }
    sec.style.display = 'block';
    const pending = people.filter(function (p) { const s = stateOf(p); return s === 'none' || s === 'error'; });
    let html = '';
    people.forEach(function (p) {
      const st = stateOf(p);
      const label = st === 'ready' ? 'Volver a investigar' : 'Investigar con IA';
      html += '<div class="mcr-row">' +
        '<div class="mcr-head">' +
          '<span class="mcr-name notranslate">' + esc(p.name || '(sin nombre)') + '</span>' + chip(st, p.research_at) +
          (st === 'running' ? '' :
            '<button type="button" class="btn btn-ghost btn-sm mcr-btn" data-mcr-id="' + esc(p.id) + '" data-credit-cost="lead_research">' + label + '</button>') +
        '</div>' +
        (p.research && st !== 'running'
          ? '<details class="mcr-details"><summary>Ver la investigación</summary><div class="mcr-text notranslate">' + esc(p.research) + '</div></details>'
          : '') +
      '</div>';
    });
    if (people.length > 1 && pending.length > 1) {
      html += '<button type="button" class="btn btn-ghost btn-sm mcr-all" data-mcr-all="1">Investigar a los ' + pending.length + ' que faltan</button>';
    }
    html += '<div class="mcr-foot">Se guarda en la lista de cada persona (Listas → Investigación) y el coach la usa en la reunión. Se orienta con tu Entrenamiento IA.</div>';
    host.innerHTML = html;
    if (global.creditCosts && global.creditCosts.decorate) global.creditCosts.decorate(host);
  }

  function errorText(e) {
    if (e && e.status === 402) return 'No te alcanzan los créditos para investigar. Recarga créditos e intenta de nuevo.';
    if (e && e.status === 409) return 'La investigación de esta persona ya está corriendo.';
    if (e && e.status === 503) return 'La investigación todavía no está activada en el servidor.';
    if (e && e.status === 400 && e.detail) return e.detail;
    return 'No se pudo investigar' + (e && e.detail ? ' (' + e.detail + ')' : '') + '. Reintenta.';
  }

  async function runOne(id) {
    if (!pd() || !pd().researchLead || running.has(id)) return false;
    running.add(id);
    render(lastCtx);
    try {
      await pd().researchLead(id, { purpose: 'meeting' });
      return true;
    } catch (e) {
      toast(errorText(e), 'error');
      return false;
    } finally {
      running.delete(id);
    }
  }

  // Relee las filas (y con ellas el contexto del coach) después de investigar.
  async function refresh() {
    if (global.coachLeadPicker && global.coachLeadPicker.sync) await global.coachLeadPicker.sync();
    else render(lastCtx);
    if (global.credits && typeof global.credits.refresh === 'function') global.credits.refresh();
  }

  async function runMany(people) {
    const queue = people.slice();
    let ok = 0;
    // De a 3 en paralelo: cada investigación tarda ~1 minuto.
    const workers = [0, 1, 2].map(async function () {
      while (queue.length) {
        const p = queue.shift();
        if (await runOne(String(p.id))) ok++;
      }
    });
    await Promise.all(workers);
    await refresh();
    if (ok) toast(ok === 1 ? 'Investigación lista.' : ok + ' investigaciones listas.', 'success');
  }

  document.addEventListener('click', function (ev) {
    const btn = ev.target.closest && ev.target.closest('[data-mcr-id], [data-mcr-all]');
    const host = document.getElementById('mc-brief-research');
    if (!btn || !host || !host.contains(btn)) return;
    const people = peopleOf(lastCtx);
    if (btn.hasAttribute('data-mcr-all')) {
      runMany(people.filter(function (p) { const s = stateOf(p); return s === 'none' || s === 'error'; }));
      return;
    }
    const id = btn.getAttribute('data-mcr-id');
    const p = people.find(function (x) { return String(x.id) === id; });
    runMany(p ? [p] : []);
  });

  // Estilos del bloque (tokens del tema; sin colores a mano).
  (function injectCss() {
    if (document.getElementById('mcr-css')) return;
    const st = document.createElement('style');
    st.id = 'mcr-css';
    st.textContent =
      '.mcr-row{padding:8px 0}.mcr-row+.mcr-row{border-top:1px dashed var(--border)}' +
      '.mcr-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.mcr-name{font-size:13px;font-weight:600;color:var(--text)}' +
      '.mcr-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--surface2);color:var(--text3)}' +
      '.mcr-ok{color:var(--green)}.mcr-err{color:var(--red)}.mcr-run{color:var(--amber)}' +
      '.mcr-btn{margin-left:auto}' +
      '.mcr-details{margin-top:6px}.mcr-details summary{cursor:pointer;font-size:12px;color:var(--accent)}' +
      '.mcr-text{margin-top:6px;font-size:12.5px;color:var(--text2);line-height:1.6;white-space:pre-line}' +
      '.mcr-all{margin-top:10px}' +
      '.mcr-foot{margin-top:10px;font-size:11.5px;color:var(--text3);line-height:1.5}';
    document.head.appendChild(st);
  })();

  global.CoachResearch = { render: render };
})(window);
