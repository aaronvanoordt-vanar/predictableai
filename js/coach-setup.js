// js/coach-setup.js
// ═══════════════════════════════════════════════════════════
// Preparación de la reunión en el AI Sales Coach (2026-11-25, feedback de
// cliente). Dos piezas del paso 2 «Con quién es la reunión»:
//
//  • CoachTeam — «Quién entra de tu empresa». A una reunión puede entrar más
//    de una persona del lado del vendedor. Aquí se marca quiénes son; todos
//    los demás hablantes se entienden como leads. Sugiere a la nómina de
//    Equipo (RPC team_overview, si la cuenta tiene equipo) y acepta nombres
//    escritos a mano; la selección se recuerda en este navegador.
//    El coach lo recibe como `context.team` (sales-coach lo acota y lo pone en
//    sus prompts); en modo asistente los nombres marcados cuentan como
//    vendedor en la transcripción.
//
//  • CoachHistory — reuniones anteriores con el lead o la lista elegida. Con
//    un lead no hay una sola reunión: el coach arranca desde donde quedó la
//    última. Lee la acción `leadHistory` de sales-coach (reportes guardados,
//    nunca inventa) y lo pinta en «Lo que sabes del lead». El historial que
//    usa el modelo lo arma el servidor al iniciar la reunión.
//
// Todo texto entra al DOM con textContent.
// ═══════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var LS_TEAM = 'predictable_coach_team';
  var MAX_TEAM = 8;
  var STAGE = { rapport: 'Apertura', discovery: 'Descubrimiento', reframe: 'Reencuadre', demo: 'Solución', negotiation: 'Objeciones y negociación', close: 'Cierre' };
  var OUTCOME = { ganado: 'Ganado', perdido: 'Perdido', seguimiento: 'En seguimiento', sin_respuesta: 'Sin respuesta' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function norm(s) { return String(s || '').trim().replace(/\s+/g, ' '); }
  function same(a, b) { return norm(a).toLowerCase() === norm(b).toLowerCase(); }
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      if (global.i18n && global.i18n.formatDate) return global.i18n.formatDate(iso, { day: 'numeric', month: 'short', year: 'numeric' });
      return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return ''; }
  }

  // ═══ CoachTeam ════════════════════════════════════════════════════════
  var team = { known: [], selected: [], roster: null };
  function loadTeam() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_TEAM) || '{}');
      var clean = function (a) { return (Array.isArray(a) ? a : []).map(norm).filter(Boolean).slice(0, 30); };
      team.known = clean(raw.known);
      team.selected = clean(raw.selected).slice(0, MAX_TEAM);
    } catch (e) { /* sin almacenamiento: se usa solo en esta sesión */ }
  }
  function saveTeam() {
    try { localStorage.setItem(LS_TEAM, JSON.stringify({ known: team.known, selected: team.selected })); } catch (e) {}
  }
  function isSelected(name) { return team.selected.some(function (x) { return same(x, name); }); }
  function toggle(name) {
    name = norm(name).slice(0, 80);
    if (!name) return;
    if (isSelected(name)) team.selected = team.selected.filter(function (x) { return !same(x, name); });
    else {
      if (team.selected.length >= MAX_TEAM) return;
      team.selected.push(name);
      if (!team.known.some(function (x) { return same(x, name); })) team.known.push(name);
    }
    saveTeam();
    renderTeam();
  }
  function forget(name) {
    team.known = team.known.filter(function (x) { return !same(x, name); });
    team.selected = team.selected.filter(function (x) { return !same(x, name); });
    saveTeam();
    renderTeam();
  }
  // Nómina de Equipo, si la cuenta tiene uno. Falla suave: sin equipo o sin
  // permiso solo quedan los nombres escritos a mano.
  async function loadRoster() {
    if (team.roster) return;
    team.roster = [];
    try {
      var sb = global.supabaseClient;
      if (!sb) return;
      var r = await sb.rpc('team_overview');
      var me = (global.currentUser && global.currentUser.id) || '';
      var rows = (r && r.data && Array.isArray(r.data.roster)) ? r.data.roster : [];
      team.roster = rows.filter(function (x) { return x && x.full_name && x.user_id !== me; })
        .map(function (x) { return norm(x.full_name); }).slice(0, 30);
      if (team.roster.length) renderTeam();
    } catch (e) { /* sin equipo */ }
  }
  function renderTeam() {
    var host = document.getElementById('mc-team');
    if (!host) return;
    host.textContent = '';
    host.appendChild(el('div', 'mc-label', 'Quién entra de tu empresa (además de ti)'));
    var names = [];
    (team.roster || []).concat(team.known).forEach(function (n) {
      if (n && !names.some(function (x) { return same(x, n); })) names.push(n);
    });
    var chips = el('div', 'mc-team-chips');
    names.forEach(function (n) {
      var on = isSelected(n);
      var chip = el('span', 'mc-team-chip' + (on ? ' is-on' : ''));
      var b = el('button', 'mc-team-name notranslate', n);
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () { toggle(n); });
      chip.appendChild(b);
      // Un nombre escrito a mano se puede olvidar; los de la nómina no.
      if (!(team.roster || []).some(function (x) { return same(x, n); })) {
        var x = el('button', 'mc-team-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Olvidar a ' + n);
        x.addEventListener('click', function () { forget(n); });
        chip.appendChild(x);
      }
      chips.appendChild(chip);
    });
    if (names.length) host.appendChild(chips);

    var row = el('div', 'mc-team-add');
    var input = el('input');
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = 'Nombre de tu compañero, tal como aparece en la reunión';
    input.setAttribute('aria-label', 'Nombre de un compañero que entra a la reunión');
    var add = el('button', 'btn btn-ghost btn-sm', 'Agregar');
    add.type = 'button';
    var commit = function () { var v = norm(input.value); if (!v) return; if (!isSelected(v)) toggle(v); else renderTeam(); };
    add.addEventListener('click', commit);
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } });
    row.appendChild(input); row.appendChild(add);
    host.appendChild(row);

    var n = team.selected.length;
    host.appendChild(el('div', 'mc-hint', n
      ? (n === 1 ? 'El coach sabe que 1 persona más vende contigo: no la tratará como lead. Todos los demás en la reunión son leads.'
        : 'El coach sabe que ' + n + ' personas más venden contigo: no las tratará como leads. Todos los demás en la reunión son leads.')
      : 'Si entras solo, déjalo vacío. Si entra alguien más de tu empresa, márcalo para que el coach no lo confunda con un lead.'));
  }
  function selectedTeam() { return team.selected.map(function (n) { return { name: n }; }); }

  // ═══ CoachHistory ═════════════════════════════════════════════════════
  var hist = { key: '', meetings: [], seq: 0 };
  function idsOf(ctx) {
    if (!ctx) return [];
    var ids = Array.isArray(ctx.member_ids) && ctx.member_ids.length ? ctx.member_ids.slice() : [];
    if (ctx.id && ids.indexOf(String(ctx.id)) === -1) ids.unshift(String(ctx.id));
    return ids.map(String).filter(Boolean);
  }
  function renderHistory() {
    var sec = document.getElementById('mc-brief-history-sec');
    var host = document.getElementById('mc-brief-history');
    var sum = document.getElementById('mc-history-summary');
    var list = hist.meetings;
    if (sum) {
      sum.textContent = '';
      sum.style.display = list.length ? '' : 'none';
      if (list.length) {
        sum.appendChild(el('span', 'mc-rs-dot is-ok'));
        sum.appendChild(el('span', 'mc-rs-t', list.length === 1
          ? 'Ya tuviste 1 reunión con este lead: el coach arranca desde donde quedó, no desde cero.'
          : 'Ya tuviste ' + list.length + ' reuniones con este lead: el coach arranca desde donde quedó la última, no desde cero.'));
      }
    }
    if (!sec || !host) return;
    sec.style.display = list.length ? '' : 'none';
    host.textContent = '';
    list.forEach(function (h) {
      var row = el('div', 'mc-hist-row');
      var head = el('div', 'mc-hist-head');
      head.appendChild(el('span', 'mc-hist-date', fmtDate(h.date)));
      if (h.stage && STAGE[h.stage]) head.appendChild(el('span', 'mc-hist-chip', 'Llegó a: ' + STAGE[h.stage]));
      if (h.outcome && OUTCOME[h.outcome]) head.appendChild(el('span', 'mc-hist-chip', OUTCOME[h.outcome]));
      row.appendChild(head);
      (Array.isArray(h.summary) ? h.summary : []).slice(0, 3).forEach(function (x) {
        if (x) row.appendChild(el('div', 'mc-hist-line notranslate', x));
      });
      if (h.next_step && h.next_step.accion) {
        var ns = el('div', 'mc-hist-next');
        ns.appendChild(el('span', 'mc-hist-next-k', 'Quedó pendiente:'));
        ns.appendChild(el('span', 'notranslate', ' ' + h.next_step.accion + (h.next_step.cuando ? ' (' + h.next_step.cuando + ')' : '')));
        row.appendChild(ns);
      }
      if (h.meeting_id && global.MeetingReport) {
        var open = el('button', 'mc-hist-open', 'Ver el reporte');
        open.type = 'button';
        open.addEventListener('click', function () {
          if (typeof global.nav === 'function') global.nav(document.querySelector('[data-page=ventas-reportes]'), 'ventas-reportes');
          global.MeetingReport.open(h.meeting_id);
        });
        row.appendChild(open);
      }
      host.appendChild(row);
    });
  }
  /** Se eligió un lead o una lista: trae sus reuniones anteriores. */
  async function onLead(ctx) {
    var ids = idsOf(ctx);
    var key = ids.join(',');
    if (key === hist.key) return;
    hist.key = key;
    hist.meetings = [];
    renderHistory();
    if (!ids.length || !global.api || !global.api.leadHistory) return;
    var seq = ++hist.seq;
    try {
      var res = await global.api.leadHistory({ member_ids: ids });
      if (seq !== hist.seq) return;       // ya se eligió otro lead
      hist.meetings = (res && Array.isArray(res.meetings)) ? res.meetings : [];
    } catch (e) {
      // Función sin desplegar o sin red: el coach funciona igual, sin historial a la vista.
      console.warn('[coach-setup] historial no disponible:', e && e.message);
    }
    renderHistory();
  }

  function init() {
    loadTeam();
    renderTeam();
    renderHistory();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  // La nómina se pide cuando ya hay sesión (el perfil llega después del DOM).
  document.addEventListener('predictable:profile-ready', loadRoster);

  global.CoachSetup = {
    team: selectedTeam,
    onLead: onLead,
    history: function () { return hist.meetings.slice(); },
    // Tras cerrar una reunión, la próxima elección debe releer el historial.
    reset: function () { hist.key = ''; },
  };
})(window);
