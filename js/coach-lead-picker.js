// js/coach-lead-picker.js
// ═══════════════════════════════════════════════════════════
// Selector de lead del AI Sales Coach (#mc-lead-select).
// Llena el <select> con los contactos de las Listas guardadas
// (Supabase, RLS por dueño) agrupados por lista, restaura el
// último handoff de Prospección (coach_lead_context) y persiste
// cada selección. El coach no puede iniciar sin un lead elegido.
//
// «Preparar con IA» (investigación de 5 capas con generate-outreach, armada
// con el Intelligence Hub) se eliminó el 2026-11-16 (pedido del dueño): esa
// investigación envejecía y desviaba al coach en la llamada. El coach entra
// solo con los datos del lead (buildCoachLeadContext). No la resucites.
//
// Reunión con varias personas (2026-11-17, pedido del dueño): cada lista con
// 2 a GROUP_MAX contactos ofrece además «Toda la lista» (value `list:<id>`),
// que junta a todos en un solo contexto (buildCoachGroupContext).
// ═══════════════════════════════════════════════════════════
(function (global) {
  let membersById = {};   // option value (member id) → contexto listo para el coach
  let wired = false;
  let oppByMember = {};   // member id → oportunidad del CRM (contacto principal)
  let loading = null;     // promesa en curso para no duplicar cargas concurrentes
  const GROUP_MAX = 12;   // espejo de COACH_GROUP_MAX (js/prospecting-data.js)

  function valueOf(ctx) {
    return ctx && ctx.group && ctx.list_id ? 'list:' + ctx.list_id : (ctx && ctx.id);
  }

  function pd() { return global.prospectingData; }
  function toast(msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
    else console.log('[coach-picker]', type, msg);
  }

  function els() {
    return {
      select: document.getElementById('mc-lead-select'),
      empty: document.getElementById('mc-lead-empty'),
    };
  }

  function optionLabel(ctx) {
    if (ctx.group) {
      const n = (ctx.participants || []).length;
      return 'Toda la lista «' + (ctx.list_name || '') + '» — ' + (n === 1 ? '1 persona' : n + ' personas');
    }
    const meta = [ctx.title, ctx.company].filter(Boolean).join(' · ');
    return (ctx.name || '(sin nombre)') + (meta ? ' — ' + meta : '');
  }

  function applySelection(ctx, persist) {
    global.predictable = global.predictable || {};
    global.predictable.currentProspect = ctx;
    if (typeof global.loadCoachBrief === 'function') global.loadCoachBrief(ctx);
    if (persist && ctx.id && pd() && pd().saveCoachContext) {
      Promise.resolve(pd().saveCoachContext(ctx.id, ctx)).catch(function (e) {
        console.warn('[coach-picker] no se pudo persistir el contexto:', e.message);
      });
    }
  }

  function onChange() {
    const ui = els();
    if (!ui.select) return;
    const ctx = membersById[ui.select.value];
    if (ctx) applySelection(ctx, true);
  }

  function wire() {
    const ui = els();
    if (wired || !ui.select) return;
    ui.select.addEventListener('change', onChange);
    wired = true;
  }

  async function fetchAllMembers() {
    const lists = await pd().fetchLists();
    // Oportunidades del CRM ligadas a un lead: sus notas entran al contexto.
    oppByMember = pd().fetchLeadOpportunities ? await pd().fetchLeadOpportunities() : {};
    const perList = await Promise.all(lists.map(function (l) {
      return pd().fetchMembers(l.id).catch(function (e) {
        console.warn('[coach-picker] lista "' + l.name + '":', e.message);
        return [];
      });
    }));
    return lists.map(function (l, i) { return { list: l, members: perList[i] }; });
  }

  function rebuildOptions(groups, current) {
    const ui = els();
    if (!ui.select) return;
    membersById = {};
    ui.select.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecciona el lead o la lista de esta reunión…';
    ui.select.appendChild(placeholder);

    let total = 0;
    groups.forEach(function (g) {
      if (!g.members.length) return;
      const og = document.createElement('optgroup');
      og.label = g.list.name;
      // Varias personas en la misma reunión: la lista entera como una opción.
      if (g.members.length >= 2 && g.members.length <= GROUP_MAX && pd().buildCoachGroupContext) {
        const gctx = pd().buildCoachGroupContext(g.list, g.members, oppByMember);
        if (gctx) {
          membersById[valueOf(gctx)] = gctx;
          const gopt = document.createElement('option');
          gopt.value = valueOf(gctx);
          gopt.textContent = optionLabel(gctx);
          og.appendChild(gopt);
        }
      }
      g.members.forEach(function (m) {
        const ctx = pd().buildCoachLeadContext(m, oppByMember[m.id]);
        membersById[ctx.id] = ctx;
        const opt = document.createElement('option');
        opt.value = ctx.id;
        opt.textContent = optionLabel(ctx);
        og.appendChild(opt);
        total++;
      });
      ui.select.appendChild(og);
    });

    // Lead restaurado desde coach_lead_context que ya no está en ninguna
    // lista (lista borrada / miembro eliminado): ofrecerlo igual para no
    // perder la sesión elegida.
    const curKey = valueOf(current);
    if (current && curKey && !membersById[curKey]) {
      membersById[curKey] = current;
      const opt = document.createElement('option');
      opt.value = curKey;
      opt.textContent = optionLabel(current);
      ui.select.insertBefore(opt, ui.select.children[1] || null);
      total++;
    }

    const hasLeads = total > 0;
    ui.select.style.display = hasLeads ? '' : 'none';
    if (ui.empty) ui.empty.style.display = hasLeads ? 'none' : '';

    if (current && curKey && membersById[curKey]) {
      ui.select.value = curKey;
      // Se repinta con la fila actual del lead (no con la copia guardada).
      applySelection(membersById[curKey], false);
    }
  }

  // Punto de entrada: se llama cada vez que el usuario navega al coach.
  // 1) restaura el último handoff si no hay lead en memoria, 2) refresca el
  // brief, 3) llena el selector y preselecciona el lead actual.
  async function sync() {
    const ui = els();
    if (!ui.select || !pd()) return;
    wire();
    if (loading) return loading;
    loading = (async function () {
      let current = global.predictable && global.predictable.currentProspect;
      if (!(current && (current.id || current.name))) {
        try {
          const lead = await pd().fetchLatestCoachContext();
          if (lead && (lead.id || lead.name)) current = lead;
        } catch (e) {
          console.warn('[coach-picker] no se pudo restaurar el contexto:', e.message);
        }
      }
      if (current && (current.id || current.name)) applySelection(current, false);

      try {
        rebuildOptions(await fetchAllMembers(), current);
      } catch (e) {
        console.warn('[coach-picker] no se pudieron cargar las listas:', e.message);
        const sel = els().select;
        if (sel && !Object.keys(membersById).length) {
          sel.innerHTML = '';
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No se pudieron cargar tus leads — reintenta';
          sel.appendChild(opt);
        }
      }
    })();
    try { await loading; } finally { loading = null; }
  }

  global.coachLeadPicker = { sync: sync };
})(window);
