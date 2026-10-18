/**
 * js/agency.js — «Agencia» (2026-10-17, docs/ROADMAP_GTM_OS.md §1 ítem 15)
 *
 * Página `agency` (shell `#agency-shell`). Para quien gestiona clientes con
 * «Entrar al espacio» (js/workspace.js):
 *
 *   · Créditos por espacio: el pozo de la agencia (su propio saldo) y, por
 *     cada espacio de cliente, saldo, gasto del mes contra el tope mensual y
 *     alerta de saldo bajo. Asignar / retirar / tope pasan por la edge
 *     function `client-workspace` (acciones transfer / settings), que llama a
 *     los RPC de service role agency_transfer_credits /
 *     agency_workspace_settings (migración 20261018180006): revalidan
 *     can_manage_client y dejan auditoría en workspace_credit_log.
 *   · Consumo por cliente: agency_usage() por período, agrupado por función
 *     (USAGE_CATEGORIES) y exportable a CSV para refacturar.
 *   · Ficha del directorio (tabla agencies): la agencia la escribe, el dueño
 *     la aprueba a mano. Aprobada + plan pago = puede abrir espacios. El
 *     directorio público vive en agencias.html.
 *
 * USAGE_CATEGORIES, NON_USAGE_REASONS, summarizeUsage y usageCsv son ESPEJO de
 * supabase/functions/_shared/agency-credits.ts (lo verifica
 * agency-credits.test.ts). Sin datos inventados: todo sale de la base.
 */
(function (global) {
  'use strict';

  if (global.Agency) return;

  var esc = global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function sb() { return global.supabaseClient; }
  function fmt(n) { return Number(n || 0).toLocaleString('es-419'); }

  // ── Espejo de _shared/agency-credits.ts ────────────────────────────────
  var USAGE_CATEGORIES = [
    { key: 'enrichment', label: 'Enriquecimiento', prefixes: ['enrich_', 'email_verify', 'lead_research_apollo', 'registry_'] },
    { key: 'ai', label: 'IA: mensajes · investigación · columnas', prefixes: ['outreach_message', 'outreach_full', 'outreach_step', 'campaign_recommendation', 'lead_research', 'ai_column'] },
    { key: 'campaigns', label: 'Campañas', prefixes: ['campaign_lead', 'campaign_send', 'inbox_'] },
    { key: 'hub', label: 'Intelligence Hub', prefixes: ['intel_hub', 'market_analysis', 'outreach_playbook'] },
    { key: 'radar', label: 'Radar', prefixes: ['radar_', 'champion_'] },
    { key: 'coach', label: 'Meeting Coach', prefixes: ['coach_'] },
    { key: 'voice', label: 'Agente de voz', prefixes: ['voice_'] },
    // Minutos del dialer de Predictable (telefonía: `call_minutes`, `call_minutes_refund`).
    { key: 'calls', label: 'Llamadas', prefixes: ['call_minutes'] },
  ];
  var OTHER_CATEGORY = { key: 'other', label: 'Otros' };
  var NON_USAGE_REASONS = ['agency_assign_in', 'agency_assign_out', 'agency_withdraw_in', 'agency_withdraw_out', 'workspace_trial_void', 'plan_expire', 'plan_grant', 'launch_reset', 'trial_grant', 'topup'];

  function baseReason(r) { return String(r || '').replace(/_refund$/, ''); }
  function usageCategory(reason) {
    var r = baseReason(reason);
    for (var i = 0; i < USAGE_CATEGORIES.length; i++) {
      var c = USAGE_CATEGORIES[i];
      if (c.prefixes.some(function (p) { return r === p || r.indexOf(p) === 0; })) return c;
    }
    return OTHER_CATEGORY;
  }
  function isUsage(reason, delta) {
    var r = String(reason || '');
    if (!r || NON_USAGE_REASONS.indexOf(r) !== -1) return false;
    if (delta < 0) return true;
    if (delta > 0) return r === 'refund' || /_refund$/.test(r);
    return false;
  }
  function summarizeUsage(rows) {
    var by = {};
    var order = [];
    (rows || []).forEach(function (row) {
      var delta = Number(row.delta_sum) || 0;
      if (!row.client_id || !isUsage(row.reason, delta)) return;
      var s = by[row.client_id];
      if (!s) { s = by[row.client_id] = { client_id: row.client_id, client_name: row.client_name || '', total: 0, by_category: {} }; order.push(s); }
      var cat = usageCategory(row.reason).key;
      s.by_category[cat] = (s.by_category[cat] || 0) - delta;
      s.total -= delta;
    });
    return order.map(function (s) {
      Object.keys(s.by_category).forEach(function (k) { if (s.by_category[k] <= 0) delete s.by_category[k]; });
      return s;
    }).filter(function (s) { return s.total > 0; })
      .sort(function (a, b) { return b.total - a.total || a.client_name.localeCompare(b.client_name); });
  }
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function usageCsv(summary, period) {
    var cats = USAGE_CATEGORIES.concat([OTHER_CATEGORY]);
    var head = ['Cliente', 'Desde', 'Hasta'].concat(cats.map(function (c) { return c.label; }), ['Total créditos']);
    var lines = [head.map(csvCell).join(',')];
    summary.forEach(function (s) {
      lines.push([s.client_name, period.from, period.to]
        .concat(cats.map(function (c) { return s.by_category[c.key] || 0; }), [s.total])
        .map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  // ── Países de la ficha (los de Clientes) ──────────────────────────────
  var COUNTRIES = ['Argentina', 'Bolivia', 'Brasil', 'Chile', 'Colombia', 'Costa Rica', 'Ecuador', 'El Salvador',
    'Guatemala', 'Honduras', 'México', 'Nicaragua', 'Panamá', 'Paraguay', 'Perú', 'Puerto Rico',
    'República Dominicana', 'Uruguay', 'Venezuela', 'Estados Unidos', 'España'];

  var STATUS = {
    pending:   { label: 'En revisión', cls: 'ag-st-amber', text: 'La revisamos a mano. Te avisamos cuando quede aprobada.' },
    approved:  { label: 'Aprobada', cls: 'ag-st-green', text: 'Tu agencia puede abrir espacios de clientes. Si marcaste «Mostrar en el directorio», aparece en el directorio público.' },
    rejected:  { label: 'No aprobada', cls: 'ag-st-red', text: 'Corrige la ficha y guárdala para que la revisemos de nuevo.' },
    suspended: { label: 'Suspendida', cls: 'ag-st-gray', text: 'Tu agencia no puede abrir espacios nuevos por ahora. Escríbenos para revisarlo.' },
  };

  var state = {
    root: null,
    access: null,
    pool: null,          // { balance, plan_balance, unlimited }
    spaces: [],
    log: [],
    agency: null,
    period: 'this_month',
    from: '', to: '',
    usage: null,
    open: null,          // { id, kind } formulario abierto en la tabla
  };

  // ── Datos ──────────────────────────────────────────────────────────────
  async function loadAccess() {
    var r = await sb().rpc('my_workspace_access');
    if (r.error) throw r.error;
    state.access = r.data || {};
    return state.access;
  }

  async function loadPool() {
    var me = global.currentUser;
    var r = await sb().from('user_credits').select('balance, plan_balance, unlimited').eq('user_id', me.id).maybeSingle();
    state.pool = r.error ? null : (r.data || { balance: 0, plan_balance: 0, unlimited: false });
  }

  async function loadSpaces() {
    var r = await sb().rpc('agency_workspaces');
    if (r.error) throw r.error;
    state.spaces = r.data || [];
  }

  async function loadLog() {
    var r = await sb().from('workspace_credit_log')
      .select('client_name, kind, amount, plan_part, monthly_cap, low_balance_alert, note, created_at, actor_user_id')
      .order('created_at', { ascending: false }).limit(25);
    state.log = r.error ? [] : (r.data || []);
  }

  async function loadAgency() {
    var me = global.currentUser;
    var r = await sb().from('agencies')
      .select('id, name, website, countries, verticals, description, listed, status, review_note, reviewed_at')
      .eq('owner_user_id', me.id).maybeSingle();
    state.agency = r.error ? null : r.data;
  }

  function periodBounds() {
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();
    var from, to;
    if (state.period === 'last_month') { from = new Date(y, m - 1, 1); to = new Date(y, m, 1); }
    else if (state.period === 'last_30') { to = new Date(y, m, now.getDate() + 1); from = new Date(to.getTime() - 30 * 86400000); }
    else if (state.period === 'custom' && state.from && state.to) {
      from = new Date(state.from + 'T00:00:00');
      to = new Date(state.to + 'T00:00:00');
      to.setDate(to.getDate() + 1);
    } else { from = new Date(y, m, 1); to = new Date(y, m + 1, 1); }
    var lastDay = new Date(to.getTime() - 86400000);
    return { from: from, to: to, label: { from: ymd(from), to: ymd(lastDay) } };
  }
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  async function loadUsage() {
    var b = periodBounds();
    if (b.to <= b.from) { state.usage = { error: 'La fecha final tiene que ser posterior a la inicial.' }; return; }
    if (b.to - b.from > 400 * 86400000) { state.usage = { error: 'El período puede tener como máximo 400 días.' }; return; }
    var r = await sb().rpc('agency_usage', { p_from: b.from.toISOString(), p_to: b.to.toISOString() });
    if (r.error) { state.usage = { error: 'No se pudo cargar el consumo: ' + r.error.message }; return; }
    state.usage = { rows: summarizeUsage(r.data || []), period: b.label };
  }

  async function callWorkspaceFn(payload) {
    var s = (await sb().auth.getSession()).data.session;
    if (!s) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/client-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.access_token },
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data || {};
  }

  // ── Pintar ─────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('agency-css')) return;
    var s = document.createElement('style');
    s.id = 'agency-css';
    s.textContent =
      '.ag-wrap{padding:20px 24px 80px;display:flex;flex-direction:column;gap:18px;max-width:1100px}' +
      '.ag-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg,14px);padding:18px}' +
      '.ag-h{font-size:15px;font-weight:700;color:var(--ink);margin:0 0 4px}' +
      '.ag-sub{font-size:12.5px;color:var(--ink-3);margin:0 0 14px;line-height:1.5}' +
      '.ag-kpis{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:14px}' +
      '.ag-kpi{flex:1 1 160px;padding:12px 14px;border-radius:var(--r-md,10px);background:var(--surface2);border:1px solid var(--border)}' +
      '.ag-kpi b{display:block;font-size:20px;color:var(--ink)}.ag-kpi span{font-size:12px;color:var(--ink-3)}' +
      '.ag-tw{overflow-x:auto}' +
      '.ag-t{width:100%;border-collapse:collapse;font-size:13px}' +
      '.ag-t th{text-align:left;font-weight:600;color:var(--ink-3);font-size:11.5px;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}' +
      '.ag-t td{padding:10px;border-bottom:1px solid var(--border);color:var(--ink);vertical-align:top}' +
      '.ag-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '.ag-acts{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}' +
      '.ag-form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;padding:10px;border-radius:var(--r-md,10px);background:var(--surface2)}' +
      '.ag-form label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--ink-3)}' +
      '.ag-in{font:inherit;font-size:13px;padding:7px 9px;border-radius:8px;border:1px solid var(--border2);background:var(--surface);color:var(--ink);min-width:0}' +
      '.ag-in[type=number]{width:120px}' +
      '.ag-chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}' +
      '.ag-st-amber{background:var(--amber-soft);color:var(--amber)}.ag-st-green{background:var(--green-soft);color:var(--green)}' +
      '.ag-st-red{background:var(--red-soft);color:var(--red)}.ag-st-gray{background:var(--surface2);color:var(--ink-3)}' +
      '.ag-row-low td{background:var(--amber-soft)}' +
      '.ag-empty{padding:18px;text-align:center;color:var(--ink-3);font-size:13px}' +
      '.ag-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}' +
      '.ag-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
      '.ag-grid .ag-full{grid-column:1/-1}' +
      '.ag-field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--ink-3)}' +
      '.ag-countries{display:flex;flex-wrap:wrap;gap:6px}' +
      '.ag-countries label{display:flex;gap:5px;align-items:center;font-size:12.5px;font-family:inherit;text-transform:none;letter-spacing:normal;color:var(--ink);padding:4px 9px;border:1px solid var(--border2);border-radius:999px;cursor:pointer}' +
      '.ag-note{font-size:12.5px;color:var(--ink-2);padding:10px 12px;border-radius:var(--r-md,10px);background:var(--surface2);margin-bottom:12px}' +
      '@media (max-width:840px){.ag-wrap{padding:16px}.ag-grid{grid-template-columns:1fr}}';
    document.head.appendChild(s);
  }

  function lowBalance(w) {
    return !w.unlimited && w.low_balance_alert != null && Number(w.balance) <= Number(w.low_balance_alert);
  }

  function renderPoolKpis() {
    var p = state.pool;
    var total = state.spaces.reduce(function (n, w) { return n + (w.unlimited ? 0 : Number(w.balance) || 0); }, 0);
    var low = state.spaces.filter(lowBalance).length;
    var pool = !p ? '—' : (p.unlimited ? 'Ilimitados' : fmt(p.balance));
    return '<div class="ag-kpis">' +
      '<div class="ag-kpi"><b>' + esc(pool) + '</b><span>Créditos de tu cuenta (para repartir)' +
        (p && !p.unlimited && Number(p.plan_balance) > 0 ? ' · ' + fmt(p.plan_balance) + ' son del plan y vencen al renovarse' : '') + '</span></div>' +
      '<div class="ag-kpi"><b>' + fmt(total) + '</b><span>Créditos asignados a ' + state.spaces.length + ' espacio' + (state.spaces.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="ag-kpi"><b>' + low + '</b><span>Espacios con saldo bajo</span></div>' +
    '</div>';
  }

  function renderForm(w) {
    var o = state.open;
    if (!o || o.id !== w.client_id) return '';
    if (o.kind === 'settings') {
      return '<tr><td colspan="5"><form class="ag-form" data-form="settings" data-id="' + esc(w.client_id) + '">' +
        '<label>Tope de gasto mensual<input class="ag-in" type="number" min="1" step="1" name="monthly_cap" placeholder="Sin tope" value="' + esc(w.monthly_cap == null ? '' : w.monthly_cap) + '"></label>' +
        '<label>Avisar con saldo menor o igual a<input class="ag-in" type="number" min="0" step="1" name="low_balance_alert" placeholder="Sin alerta" value="' + esc(w.low_balance_alert == null ? '' : w.low_balance_alert) + '"></label>' +
        '<button class="btn btn-primary btn-sm" type="submit">Guardar</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-cancel>Cancelar</button>' +
        '<div style="flex-basis:100%;font-size:11.5px;color:var(--ink-3)">El tope cuenta el mes calendario: al llegar a él, las acciones que cobran créditos se frenan en ese espacio hasta el mes siguiente. Vacío = sin tope.</div>' +
      '</form></td></tr>';
    }
    var assign = o.kind === 'assign';
    return '<tr><td colspan="5"><form class="ag-form" data-form="' + (assign ? 'assign' : 'withdraw') + '" data-id="' + esc(w.client_id) + '">' +
      '<label>' + (assign ? 'Créditos a asignar' : 'Créditos a retirar') +
        '<input class="ag-in" type="number" min="1" step="1" name="amount" required max="' + esc(assign ? (state.pool && state.pool.balance) || 0 : w.balance || 0) + '"></label>' +
      '<label style="flex:1 1 200px">Nota (opcional)<input class="ag-in" type="text" maxlength="200" name="note" placeholder="Ej. bolsa de octubre"></label>' +
      '<button class="btn btn-primary btn-sm" type="submit">' + (assign ? 'Asignar' : 'Retirar') + '</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-cancel>Cancelar</button>' +
    '</form></td></tr>';
  }

  function renderSpaces() {
    if (!state.spaces.length) {
      return '<div class="ag-empty">Todavía no tienes espacios de clientes. Entra al espacio de un cliente desde <b>Clientes</b> y aparecerá aquí.</div>';
    }
    var poolUnlimited = state.pool && state.pool.unlimited;
    var rows = state.spaces.map(function (w) {
      var low = lowBalance(w);
      var bal = w.unlimited ? 'Ilimitado' : fmt(w.balance);
      var spent = fmt(w.spent_this_month) + (w.monthly_cap != null ? ' / ' + fmt(w.monthly_cap) : '');
      var alert = w.low_balance_alert == null ? '—' : '≤ ' + fmt(w.low_balance_alert);
      var canMove = !w.unlimited && !poolUnlimited;
      return '<tr class="' + (low ? 'ag-row-low' : '') + '">' +
        '<td><b>' + esc(w.client_name) + '</b>' + (low ? ' <span class="ag-chip ag-st-amber">Saldo bajo</span>' : '') +
          (w.monthly_cap != null && Number(w.spent_this_month) >= Number(w.monthly_cap) ? ' <span class="ag-chip ag-st-red">Llegó al tope</span>' : '') + '</td>' +
        '<td class="ag-num">' + esc(bal) + (!w.unlimited && Number(w.plan_balance) > 0 ? '<div style="font-size:11px;color:var(--ink-3)">' + fmt(w.plan_balance) + ' vencen con tu plan</div>' : '') + '</td>' +
        '<td class="ag-num">' + esc(spent) + '</td>' +
        '<td class="ag-num">' + esc(alert) + '</td>' +
        '<td><div class="ag-acts">' +
          (canMove ? '<button class="btn btn-primary btn-sm" data-act="assign" data-id="' + esc(w.client_id) + '">Asignar</button>' +
                     '<button class="btn btn-ghost btn-sm" data-act="withdraw" data-id="' + esc(w.client_id) + '">Retirar</button>' : '') +
          '<button class="btn btn-ghost btn-sm" data-act="settings" data-id="' + esc(w.client_id) + '">Tope y alerta</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="enter" data-id="' + esc(w.client_id) + '">Entrar →</button>' +
        '</div></td>' +
      '</tr>' + renderForm(w);
    }).join('');
    return '<div class="ag-tw"><table class="ag-t"><thead><tr>' +
      '<th>Cliente</th><th class="ag-num">Saldo</th><th class="ag-num">Gastado este mes / tope</th><th class="ag-num">Alerta</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  var LOG_KIND = {
    assign: 'Asignó', withdraw: 'Retiró', return_on_delete: 'Devuelto al borrar el cliente',
    trial_void: 'Prueba gratis anulada al crear el espacio', settings: 'Cambió tope / alerta',
  };
  function renderLog() {
    if (!state.log.length) return '';
    var me = global.currentUser && global.currentUser.id;
    return '<details style="margin-top:14px"><summary style="cursor:pointer;font-size:12.5px;color:var(--ink-2)">Movimientos recientes (' + state.log.length + ')</summary>' +
      '<div class="ag-tw"><table class="ag-t" style="margin-top:8px"><thead><tr><th>Fecha</th><th>Cliente</th><th>Movimiento</th><th class="ag-num">Créditos</th><th>Nota</th></tr></thead><tbody>' +
      state.log.map(function (l) {
        var what = LOG_KIND[l.kind] || l.kind;
        if (l.kind === 'settings') what += ': tope ' + (l.monthly_cap == null ? 'sin tope' : fmt(l.monthly_cap)) + ', alerta ' + (l.low_balance_alert == null ? 'sin alerta' : fmt(l.low_balance_alert));
        if (l.actor_user_id && l.actor_user_id !== me && l.kind !== 'settings') what += ' (otra persona del equipo)';
        return '<tr><td style="white-space:nowrap">' + esc(new Date(l.created_at).toLocaleString('es-419', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</td>' +
          '<td>' + esc(l.client_name || '—') + '</td><td>' + esc(what) + '</td>' +
          '<td class="ag-num">' + (l.kind === 'settings' ? '—' : (l.kind === 'assign' ? '+' : '−') + fmt(l.amount)) + '</td>' +
          '<td>' + esc(l.note || '') + '</td></tr>';
      }).join('') + '</tbody></table></div></details>';
  }

  function renderUsage() {
    var periodSel = '<select class="ag-in" id="ag-period">' +
      [['this_month', 'Este mes'], ['last_month', 'Mes pasado'], ['last_30', 'Últimos 30 días'], ['custom', 'Personalizado']].map(function (o) {
        return '<option value="' + o[0] + '"' + (state.period === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
    var custom = state.period === 'custom'
      ? '<input class="ag-in" type="date" id="ag-from" value="' + esc(state.from) + '"> – <input class="ag-in" type="date" id="ag-to" value="' + esc(state.to) + '"> <button class="btn btn-ghost btn-sm" id="ag-apply">Aplicar</button>'
      : '';
    var u = state.usage;
    var body;
    if (!u) body = '<div class="ag-empty">Cargando…</div>';
    else if (u.error) body = '<div class="ag-empty">' + esc(u.error) + '</div>';
    else if (!u.rows.length) body = '<div class="ag-empty">Ningún espacio gastó créditos entre el ' + esc(u.period.from) + ' y el ' + esc(u.period.to) + '.</div>';
    else {
      var cats = USAGE_CATEGORIES.concat([OTHER_CATEGORY]).filter(function (c) {
        return u.rows.some(function (r) { return r.by_category[c.key]; });
      });
      var totals = {};
      var grand = 0;
      u.rows.forEach(function (r) {
        grand += r.total;
        cats.forEach(function (c) { totals[c.key] = (totals[c.key] || 0) + (r.by_category[c.key] || 0); });
      });
      body = '<div class="ag-tw"><table class="ag-t"><thead><tr><th>Cliente</th>' +
        cats.map(function (c) { return '<th class="ag-num">' + esc(c.label) + '</th>'; }).join('') + '<th class="ag-num">Total</th></tr></thead><tbody>' +
        u.rows.map(function (r) {
          return '<tr><td>' + esc(r.client_name) + '</td>' +
            cats.map(function (c) { return '<td class="ag-num">' + (r.by_category[c.key] ? fmt(r.by_category[c.key]) : '—') + '</td>'; }).join('') +
            '<td class="ag-num"><b>' + fmt(r.total) + '</b></td></tr>';
        }).join('') +
        '<tr><td><b>Total</b></td>' + cats.map(function (c) { return '<td class="ag-num"><b>' + fmt(totals[c.key]) + '</b></td>'; }).join('') +
        '<td class="ag-num"><b>' + fmt(grand) + '</b></td></tr>' +
        '</tbody></table></div>';
    }
    return '<div class="ag-bar">' + periodSel + custom +
      '<span style="flex:1"></span><button class="btn btn-ghost btn-sm" id="ag-csv"' + (u && u.rows && u.rows.length ? '' : ' disabled') + '>Exportar CSV</button></div>' +
      body +
      '<div style="font-size:11.5px;color:var(--ink-3);margin-top:10px">Créditos netos: lo gastado menos lo que se devolvió (por ejemplo, un email que Apollo no encontró). Los repartos entre tu cuenta y los espacios no cuentan como consumo. Las fechas van en tu hora local.</div>';
  }

  function renderAgencyForm() {
    var a = state.agency || {};
    var st = a.status ? STATUS[a.status] : null;
    var locked = a.status === 'approved' || a.status === 'suspended';
    var dis = locked ? ' disabled' : '';
    var acc = state.access || {};
    var notes = '';
    if (st) {
      notes += '<div class="ag-note"><span class="ag-chip ' + st.cls + '">' + esc(st.label) + '</span> ' + esc(st.text) +
        (a.review_note ? '<div style="margin-top:6px"><b>Nota de la revisión:</b> ' + esc(a.review_note) + '</div>' : '') + '</div>';
    }
    if (!acc.team && !acc.paid_plan) {
      notes += '<div class="ag-note">Para abrir espacios de clientes tu agencia necesita, además de la ficha aprobada, un plan <b>Starter</b> o <b>Growth</b> activo. Puedes enviar la ficha antes.</div>';
    }
    if (locked) notes += '<div class="ag-note">Tu ficha ya fue revisada. Para cambiar nombre, sitio, países o verticales escríbenos y la revisamos de nuevo. Mostrarla u ocultarla del directorio lo decides tú.</div>';
    var countries = a.countries || [];
    return notes + '<form id="ag-agency-form" class="ag-grid">' +
      '<label class="ag-field">Nombre de la agencia<input class="ag-in" name="name" required minlength="2" maxlength="80" value="' + esc(a.name || '') + '"' + dis + '></label>' +
      '<label class="ag-field">Sitio web<input class="ag-in" name="website" type="url" maxlength="300" placeholder="https://tuagencia.com" value="' + esc(a.website || '') + '"' + dis + '></label>' +
      '<div class="ag-field ag-full">Países donde trabajas<div class="ag-countries">' + COUNTRIES.map(function (c) {
        return '<label><input type="checkbox" name="countries" value="' + esc(c) + '"' + (countries.indexOf(c) !== -1 ? ' checked' : '') + dis + '>' + esc(c) + '</label>';
      }).join('') + '</div></div>' +
      '<label class="ag-field ag-full">Verticales (separadas por coma)<input class="ag-in" name="verticals" maxlength="600" placeholder="SaaS B2B, logística, salud" value="' + esc((a.verticals || []).join(', ')) + '"' + dis + '></label>' +
      '<label class="ag-field ag-full">Qué hace tu agencia (opcional, se muestra en el directorio)<textarea class="ag-in" name="description" maxlength="600" rows="3"' + dis + '>' + esc(a.description || '') + '</textarea></label>' +
      '<label class="ag-full" style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink)"><input type="checkbox" name="listed"' + (a.listed === false ? '' : ' checked') + '> Mostrar en el directorio público de agencias</label>' +
      '<div class="ag-full" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn btn-primary btn-sm" type="submit">' + (a.id ? 'Guardar ficha' : 'Enviar a revisión') + '</button>' +
        '<a class="btn btn-ghost btn-sm" href="agencias.html" target="_blank" rel="noopener">Ver el directorio</a>' +
      '</div>' +
    '</form>';
  }

  function render() {
    if (!state.root) return;
    var acc = state.access || {};
    if (acc.inside_workspace) {
      state.root.innerHTML = '<div class="ag-wrap"><div class="ag-card"><div class="ag-empty">Estás dentro del espacio de un cliente. Los créditos y el consumo de tus clientes se gestionan desde tu cuenta: usa «Volver a mi cuenta».</div></div></div>';
      return;
    }
    var html = '<div class="ag-wrap">';
    if (acc.can_open) {
      html +=
        '<section class="ag-card"><h3 class="ag-h">Créditos por espacio</h3>' +
          '<p class="ag-sub">Compras una vez en tu cuenta y repartes a cada cliente. Lo que asignas sale primero de la bolsa de tu plan y vence con ella; las recargas no vencen. Si borras un cliente, su saldo vuelve a tu cuenta.</p>' +
          renderPoolKpis() + renderSpaces() + renderLog() +
        '</section>' +
        '<section class="ag-card"><h3 class="ag-h">Consumo por cliente</h3>' +
          '<p class="ag-sub">Créditos que gastó cada espacio por función, para refacturar a tus clientes.</p>' +
          renderUsage() +
        '</section>';
    } else {
      html += '<section class="ag-card"><h3 class="ag-h">Predictable para agencias</h3>' +
        '<p class="ag-sub" style="margin:0">Si gestionas la prospección de varios clientes, cada uno puede tener su propio Predictable (Contexto, Radar, Listas, Campañas) dentro de tu cuenta: tú compras los créditos y los repartes, y ves cuánto gastó cada cliente para refacturarle. Envía la ficha de tu agencia; la aprobamos a mano.</p></section>';
    }
    html += '<section class="ag-card"><h3 class="ag-h">Ficha de tu agencia</h3>' +
      '<p class="ag-sub">Es la que aparece en el directorio público de agencias. Solo se publica cuando la aprobamos.</p>' +
      renderAgencyForm() + '</section>';
    html += '</div>';
    state.root.innerHTML = html;
    bind();
  }

  // ── Eventos ────────────────────────────────────────────────────────────
  function bind() {
    var root = state.root;
    root.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var act = btn.getAttribute('data-act');
        if (act === 'enter') {
          if (!global.Workspace) return;
          btn.disabled = true;
          btn.textContent = 'Abriendo…';
          global.Workspace.enter(id).catch(function (e) {
            btn.disabled = false;
            btn.textContent = 'Entrar →';
            toast('No se pudo entrar al espacio: ' + (e.message || e), 'error');
          });
          return;
        }
        state.open = (state.open && state.open.id === id && state.open.kind === act) ? null : { id: id, kind: act };
        render();
        var inp = root.querySelector('form[data-id="' + id + '"] input');
        if (inp) inp.focus();
      });
    });
    root.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', function () { state.open = null; render(); });
    });
    root.querySelectorAll('form[data-form]').forEach(function (f) {
      f.addEventListener('submit', function (ev) { ev.preventDefault(); onSubmitSpace(f); });
    });

    var period = root.querySelector('#ag-period');
    if (period) period.addEventListener('change', function () {
      state.period = period.value;
      if (state.period === 'custom') {
        var b = periodBounds();
        state.from = state.from || b.label.from;
        state.to = state.to || b.label.to;
      }
      refreshUsage();
    });
    var apply = root.querySelector('#ag-apply');
    if (apply) apply.addEventListener('click', function () {
      state.from = root.querySelector('#ag-from').value;
      state.to = root.querySelector('#ag-to').value;
      refreshUsage();
    });
    var csv = root.querySelector('#ag-csv');
    if (csv) csv.addEventListener('click', downloadCsv);

    var af = root.querySelector('#ag-agency-form');
    if (af) af.addEventListener('submit', function (ev) { ev.preventDefault(); onSubmitAgency(af); });
  }

  async function onSubmitSpace(form) {
    var id = form.getAttribute('data-id');
    var kind = form.getAttribute('data-form');
    var btn = form.querySelector('button[type=submit]');
    var payload;
    if (kind === 'settings') {
      payload = { action: 'settings', client_id: id, monthly_cap: form.monthly_cap.value.trim(), low_balance_alert: form.low_balance_alert.value.trim() };
    } else {
      var n = parseInt(form.amount.value, 10);
      if (!(n > 0)) { toast('Escribe cuántos créditos.', 'error'); return; }
      payload = { action: 'transfer', client_id: id, amount: kind === 'withdraw' ? -n : n, note: form.note.value };
    }
    btn.disabled = true;
    try {
      await callWorkspaceFn(payload);
      toast(kind === 'settings' ? 'Tope y alerta guardados.' : (kind === 'assign' ? 'Créditos asignados.' : 'Créditos retirados.'), 'success');
      state.open = null;
      await Promise.all([loadPool(), loadSpaces(), loadLog()]);
      render();
      if (global.credits && global.credits.refresh) global.credits.refresh();
      document.dispatchEvent(new CustomEvent('predictable:agency-spaces', { detail: state.spaces }));
    } catch (e) {
      btn.disabled = false;
      toast(e.message || String(e), 'error');
    }
  }

  async function onSubmitAgency(form) {
    var btn = form.querySelector('button[type=submit]');
    var a = state.agency;
    var locked = a && (a.status === 'approved' || a.status === 'suspended');
    var row;
    if (locked) {
      row = { listed: form.listed.checked };
    } else {
      var website = form.website.value.trim();
      if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
      row = {
        name: form.name.value.trim(),
        website: website || null,
        countries: Array.prototype.slice.call(form.querySelectorAll('input[name=countries]:checked')).map(function (i) { return i.value; }),
        verticals: form.verticals.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 20),
        description: form.description.value.trim() || null,
        listed: form.listed.checked,
      };
      if (row.name.length < 2) { toast('Escribe el nombre de tu agencia.', 'error'); return; }
    }
    btn.disabled = true;
    var res = a && a.id
      ? await sb().from('agencies').update(row).eq('id', a.id)
      : await sb().from('agencies').insert(row);
    btn.disabled = false;
    if (res.error) { toast('No se pudo guardar la ficha: ' + res.error.message, 'error'); return; }
    toast(a && a.id ? 'Ficha guardada.' : 'Ficha enviada. La revisamos a mano.', 'success');
    await loadAgency();
    render();
  }

  async function refreshUsage() {
    state.usage = null;
    render();
    await loadUsage();
    render();
  }

  function downloadCsv() {
    var u = state.usage;
    if (!u || !u.rows || !u.rows.length) return;
    var blob = new Blob(['﻿' + usageCsv(u.rows, u.period)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'consumo-por-cliente_' + u.period.from + '_' + u.period.to + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ── Entrada ────────────────────────────────────────────────────────────
  async function show() {
    // Restaurada desde el hash antes de tener sesión: se monta al llegar el perfil.
    if (!global.currentUser) {
      document.addEventListener('predictable:profile-ready', show, { once: true });
      return;
    }
    state.root = document.getElementById('agency-shell');
    if (!state.root || !sb()) return;
    injectCss();
    state.root.innerHTML = '<div class="ag-wrap"><div class="ag-card"><div class="ag-empty">Cargando…</div></div></div>';
    try {
      await loadAccess();
    } catch (e) {
      state.root.innerHTML = '<div class="ag-wrap"><div class="ag-card"><div class="ag-empty">Esta sección todavía no está disponible.</div></div></div>';
      return;
    }
    var jobs = [loadAgency()];
    if (state.access.can_open && !state.access.inside_workspace) jobs.push(loadPool(), loadSpaces(), loadLog(), loadUsage());
    try { await Promise.all(jobs); } catch (e) { toast('No se pudieron cargar los espacios: ' + (e.message || e), 'error'); }
    render();
  }

  // Menú: «Agencia» no tiene sentido dentro de un espacio, y una agencia
  // aprobada sí necesita Clientes (auth-guard.js lo esconde a toda cuenta que
  // no sea @vanarsi.com; las políticas RLS siguen decidiendo el acceso real).
  async function syncNav() {
    if (!sb() || !global.currentUser) return;
    var acc;
    try { acc = await loadAccess(); } catch (e) { return; }
    document.querySelectorAll('.nav-item[data-page="agency"]').forEach(function (el) {
      el.style.display = acc.inside_workspace ? 'none' : '';
    });
    if (acc.can_open && !acc.inside_workspace) {
      document.querySelectorAll('.nav-item[data-page="clients"]').forEach(function (el) { el.style.display = ''; });
    }
    // Restaurada desde el hash antes de tener sesión: montarla ahora.
    var page = document.getElementById('page-agency');
    if (page && page.classList.contains('active') && !state.root) show();
  }
  document.addEventListener('predictable:profile-ready', syncNav);
  if (global.currentUser) syncNav();

  global.Agency = {
    show: show,
    _test: { summarizeUsage: summarizeUsage, usageCsv: usageCsv, usageCategory: usageCategory },
  };
})(window);
