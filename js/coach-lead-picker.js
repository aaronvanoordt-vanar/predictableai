// js/coach-lead-picker.js
// ═══════════════════════════════════════════════════════════
// Selector de lead del Meeting Coach (#mc-lead-select).
// Llena el <select> con los contactos de las Listas guardadas
// (Supabase, RLS por dueño) agrupados por lista, restaura el
// último handoff de Prospección (coach_lead_context) y persiste
// cada selección. El coach no puede iniciar sin un lead elegido.
// ═══════════════════════════════════════════════════════════
(function (global) {
  let membersById = {};   // option value (member id) → contexto listo para el coach
  let wired = false;
  let loading = null;     // promesa en curso para no duplicar cargas concurrentes

  function pd() { return global.prospectingData; }

  function els() {
    return {
      select: document.getElementById('mc-lead-select'),
      empty: document.getElementById('mc-lead-empty'),
    };
  }

  function optionLabel(ctx) {
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
    placeholder.textContent = 'Selecciona el lead de esta reunión…';
    ui.select.appendChild(placeholder);

    let total = 0;
    groups.forEach(function (g) {
      if (!g.members.length) return;
      const og = document.createElement('optgroup');
      og.label = g.list.name;
      g.members.forEach(function (m) {
        const ctx = pd().buildCoachLeadContext(m);
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
    // perder el contexto preparado.
    if (current && current.id && !membersById[current.id]) {
      membersById[current.id] = current;
      const opt = document.createElement('option');
      opt.value = current.id;
      opt.textContent = optionLabel(current);
      ui.select.insertBefore(opt, ui.select.children[1] || null);
      total++;
    }

    const hasLeads = total > 0;
    ui.select.style.display = hasLeads ? '' : 'none';
    if (ui.empty) ui.empty.style.display = hasLeads ? 'none' : '';

    if (current && current.id && membersById[current.id]) {
      ui.select.value = current.id;
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
