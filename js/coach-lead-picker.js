// js/coach-lead-picker.js
// ═══════════════════════════════════════════════════════════
// Selector de lead del Meeting Coach (#mc-lead-select).
// Llena el <select> con los contactos de las Listas guardadas
// (Supabase, RLS por dueño) agrupados por lista, restaura el
// último handoff de Prospección (coach_lead_context) y persiste
// cada selección. El coach no puede iniciar sin un lead elegido.
//
// "Preparar con IA" (#mc-lead-prep): investiga al lead en 5 capas con
// generate-outreach y guarda el resultado en prospect_list_members.outreach
// (lo persiste la propia edge function). De ahí salen el ángulo, la objeción
// probable y el coach_prep que lee buildCoachLeadContext. Cuesta 4 créditos.
// Es la ÚNICA entrada a esa generación desde el 2026-09-15: los mensajes de
// una campaña son de la campaña (campaign_messages, uno por paso), no del
// lead de la lista. No la vuelvas a colgar de Listas ni del enrolamiento.
// ═══════════════════════════════════════════════════════════
(function (global) {
  let membersById = {};   // option value (member id) → contexto listo para el coach
  let memberRows = {};    // option value (member id) → fila cruda de la lista
  let wired = false;
  let loading = null;     // promesa en curso para no duplicar cargas concurrentes
  let preparing = false;  // una preparación a la vez

  function pd() { return global.prospectingData; }
  function toast(msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
    else console.log('[coach-picker]', type, msg);
  }

  function els() {
    return {
      select: document.getElementById('mc-lead-select'),
      empty: document.getElementById('mc-lead-empty'),
      prep: document.getElementById('mc-lead-prep'),
      prepBtn: document.getElementById('mc-lead-prep-btn'),
      prepNote: document.getElementById('mc-lead-prep-note'),
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
    renderPrep();
  }

  // ── Preparar con IA ────────────────────────────────────────
  function hasPrep(m) { return !!(m && m.outreach && m.outreach.generated_at); }

  /** Estado del botón según el lead elegido. */
  function renderPrep() {
    const ui = els();
    if (!ui.prep || !ui.prepBtn) return;
    const id = ui.select && ui.select.value;
    const member = id ? memberRows[id] : null;
    if (!id) { ui.prep.style.display = 'none'; return; }
    ui.prep.style.display = '';
    if (preparing) {
      ui.prepBtn.disabled = true;
      ui.prepBtn.textContent = '⏳ Investigando al lead…';
      ui.prepNote.textContent = 'Tarda cerca de un minuto. Puedes quedarte en esta pantalla.';
      return;
    }
    if (!member) {
      // Lead restaurado del último handoff que ya no está en ninguna lista.
      ui.prepBtn.disabled = true;
      ui.prepBtn.textContent = 'Preparar con IA';
      ui.prepNote.textContent = 'Este lead ya no está en ninguna de tus listas: no se puede volver a investigar.';
      return;
    }
    const ready = hasPrep(member);
    ui.prepBtn.disabled = false;
    ui.prepBtn.textContent = ready ? 'Volver a preparar con IA' : 'Preparar con IA';
    ui.prepNote.textContent = ready
      ? 'Listo: el coach entra con su ángulo, la objeción probable y su neutralizador.'
      : 'Sin preparar: el coach entra solo con nombre, cargo y empresa. Investiga al lead en 5 capas.';
  }

  async function onPrepare() {
    const ui = els();
    const id = ui.select && ui.select.value;
    const member = id ? memberRows[id] : null;
    if (!member || preparing || !pd()) return;
    preparing = true;
    renderPrep();
    try {
      // Sin el brief de tu empresa no hay base honesta para personalizar:
      // se genera (o se espera) antes de investigar al lead.
      if (pd().ensureBriefReady) {
        await pd().ensureBriefReady(function (text) {
          if (ui.prepNote && text) ui.prepNote.textContent = text;
        });
      }
      if (pd().updateMember) {
        await Promise.resolve(pd().updateMember(member.id, { outreach_status: 'generating' })).catch(function () {});
      }
      // La edge function guarda el resultado en la fila del lead.
      const outreach = await pd().generateOutreach({ member: member });
      member.outreach = Object.assign({}, outreach, { generated_at: new Date().toISOString() });
      member.outreach_status = 'ready';
      const ctx = pd().buildCoachLeadContext(member);
      membersById[ctx.id] = ctx;
      applySelection(ctx, true);
      toast('Lead preparado: el coach ya tiene su contexto.', 'success');
    } catch (e) {
      member.outreach_status = 'error';
      toast((e && e.message) || 'No se pudo preparar el lead.', 'error');
    } finally {
      preparing = false;
      renderPrep();
    }
  }

  function wire() {
    const ui = els();
    if (wired || !ui.select) return;
    ui.select.addEventListener('change', onChange);
    if (ui.prepBtn) ui.prepBtn.addEventListener('click', onPrepare);
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
    memberRows = {};
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
        memberRows[ctx.id] = m;
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
    renderPrep();
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
