/**
 * apollo-icp-chips.js — Llena los containers del ICP Builder con chips clickeables
 *
 * Tu ICP Builder usa el patron de chips (.icp-tag .icp-tag-active .icp-tag-exclude)
 * en lugar de <select multiple>. Este modulo crea esos chips automaticamente.
 *
 * Containers que llena (ya existen en tu index.html):
 *   #icp-mgmt-level   <- seniorities
 *   #icp-departments  <- departments
 *   #icp-locations    <- countries
 *   #icp-employees    <- employee_ranges
 *   #icp-industries   <- industries (subset por defecto)
 *   #icp-tech-active  <- tecnologias activas (autocomplete)
 *   #icp-tech-exclude <- empresas a excluir (autocomplete)
 *
 * Al hacer click en un chip se togglea entre normal (gris) y active (gold).
 * Para los excluye, alterna entre normal y exclude (rojo).
 *
 * Expone:
 *   window.apolloChips.getSelected('mgmt_level') → ['c_suite', 'vp', ...]
 *   window.apolloChips.getSelected('departments') → ['sales', 'marketing']
 *   ...etc
 */
(function (global) {
  'use strict';

  const STATE_KEY = 'apollo_icp_state_v1';

  // Estado interno: por cada container, qué chips estan seleccionados
  let state = {};
  try { state = JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch (e) { state = {}; }

  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // ─── Renderizar chips ─────────────────────────────────────
  function renderChips(containerId, items, mode) {
    // mode: 'select' (default, toggle active gold) | 'exclude' (toggle exclude red)
    const el = document.getElementById(containerId);
    if (!el) return;

    const selected = new Set(state[containerId] || []);
    const cls = mode === 'exclude' ? 'icp-tag-exclude' : 'icp-tag-active';

    el.innerHTML = items.map(item => {
      const isSel = selected.has(item.value);
      return `<span class="icp-tag ${isSel ? cls : ''}" data-value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</span>`;
    }).join('');

    // Click handler
    el.querySelectorAll('.icp-tag[data-value]').forEach(chip => {
      chip.addEventListener('click', () => {
        const val = chip.getAttribute('data-value');
        const arr = state[containerId] || [];
        const idx = arr.indexOf(val);
        if (idx === -1) { arr.push(val); chip.classList.add(cls); }
        else            { arr.splice(idx, 1); chip.classList.remove(cls); }
        state[containerId] = arr;
        saveState();
        emit(containerId, arr);
      });
    });
  }

  // ─── Render chips agrupados (para industrias) ─────────────
  function renderGroupedChips(containerId, items, mode) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const selected = new Set(state[containerId] || []);
    const cls = mode === 'exclude' ? 'icp-tag-exclude' : 'icp-tag-active';

    // Agrupar
    const groups = {};
    items.forEach(it => {
      const g = it.group || 'Otros';
      if (!groups[g]) groups[g] = [];
      groups[g].push(it);
    });

    let html = '';
    Object.keys(groups).forEach(group => {
      html += `<div style="width:100%;font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-top:8px;margin-bottom:4px">${escapeHtml(group)}</div>`;
      html += '<div style="display:flex;flex-wrap:wrap;gap:5px;width:100%">';
      groups[group].forEach(item => {
        const isSel = selected.has(item.value);
        html += `<span class="icp-tag ${isSel ? cls : ''}" data-value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</span>`;
      });
      html += '</div>';
    });

    el.innerHTML = html;
    el.style.display = 'block';

    el.querySelectorAll('.icp-tag[data-value]').forEach(chip => {
      chip.addEventListener('click', () => {
        const val = chip.getAttribute('data-value');
        const arr = state[containerId] || [];
        const idx = arr.indexOf(val);
        if (idx === -1) { arr.push(val); chip.classList.add(cls); }
        else            { arr.splice(idx, 1); chip.classList.remove(cls); }
        state[containerId] = arr;
        saveState();
        emit(containerId, arr);
      });
    });
  }

  // ─── Autocomplete dinamico (tech, company) ────────────────
  function attachAutocomplete(inputId, containerId, type, mode) {
    const input = document.getElementById(inputId);
    const container = document.getElementById(containerId);
    if (!input || !container) return;

    // Inicializar chips desde state si los hay
    const cls = mode === 'exclude' ? 'icp-tag-exclude' : 'icp-tag-active';
    const existing = state[containerId] || [];
    if (existing.length) {
      existing.forEach(v => addChipToContainer(containerId, { id: v, name: v }, cls));
    }

    // Dropdown contenedor
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;width:100%;margin-top:6px';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const dropdown = document.createElement('div');
    dropdown.style.cssText = 'position:absolute;top:calc(100% + 4px);left:0;right:0;' +
      'background:var(--surface);border:1px solid var(--border2);border-radius:6px;' +
      'max-height:220px;overflow-y:auto;z-index:1000;display:none;' +
      'box-shadow:0 8px 20px rgba(0,0,0,.4)';
    wrapper.appendChild(dropdown);

    let timer = null;
    let cache = {};

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { dropdown.style.display = 'none'; return; }
      if (cache[q]) { render(cache[q]); return; }
      dropdown.innerHTML = '<div style="padding:8px 10px;color:var(--text3);font-size:11px">Buscando…</div>';
      dropdown.style.display = 'block';
      timer = setTimeout(async () => {
        const results = await apolloSearchRequest(type, q);
        cache[q] = results;
        render(results);
      }, 280);
    });

    input.addEventListener('blur', () => setTimeout(() => dropdown.style.display = 'none', 200));

    function render(results) {
      if (results.length === 0) {
        dropdown.innerHTML = '<div style="padding:8px 10px;color:var(--text3);font-size:11px">Sin resultados</div>';
        return;
      }
      dropdown.innerHTML = results.map((r, i) => `
        <div data-idx="${i}" style="padding:7px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px;border-bottom:1px solid var(--border)">
          ${r.logo ? '<img src="' + r.logo + '" style="width:18px;height:18px;border-radius:3px;object-fit:cover" onerror="this.style.display=\\'none\\'">' : ''}
          <div style="flex:1;min-width:0">
            <div style="color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.name)}</div>
            ${r.sub ? '<div style="color:var(--text3);font-size:10px">' + escapeHtml(r.sub) + '</div>' : ''}
          </div>
        </div>
      `).join('');
      dropdown.querySelectorAll('[data-idx]').forEach((el, idx) => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const r = results[idx];
          addChipToContainer(containerId, r, cls);
          const arr = state[containerId] || [];
          if (!arr.includes(r.id)) arr.push(r.id);
          state[containerId] = arr;
          saveState();
          input.value = '';
          dropdown.style.display = 'none';
          emit(containerId, arr);
        });
      });
    }
  }

  function addChipToContainer(containerId, item, cls) {
    const container = document.getElementById(containerId);
    if (!container) return;
    // Si ya existe el chip, no duplicar
    if (container.querySelector(`[data-value="${item.id}"]`)) return;
    const chip = document.createElement('span');
    chip.className = 'icp-tag ' + cls;
    chip.setAttribute('data-value', item.id);
    chip.innerHTML = escapeHtml(item.name) +
      ' <button style="background:none;border:0;color:inherit;cursor:pointer;font-size:13px;padding:0 0 0 4px;margin-left:2px;line-height:1" data-remove="1">×</button>';
    chip.querySelector('[data-remove]').addEventListener('click', (e) => {
      e.stopPropagation();
      chip.remove();
      const arr = (state[containerId] || []).filter(v => v !== item.id);
      state[containerId] = arr;
      saveState();
      emit(containerId, arr);
    });
    // Insertar antes del boton "+ Add" si lo hay
    const addBtn = container.querySelector('button');
    if (addBtn) container.insertBefore(chip, addBtn);
    else container.appendChild(chip);
  }

  async function apolloSearchRequest(type, q) {
    const cfg = global.PREDICTABLE_CONFIG || {};
    const workerUrl = (cfg.APOLLO_WORKER_URL || cfg.WORKER_URL || '').replace(/\/$/, '');
    if (!workerUrl) {
      console.warn('[apollo-icp-chips] APOLLO_WORKER_URL no configurado');
      return [];
    }
    try {
      const resp = await fetch(workerUrl + '/apollo/search?type=' + encodeURIComponent(type) + '&q=' + encodeURIComponent(q));
      if (!resp.ok) return [];
      const json = await resp.json();
      return json.results || [];
    } catch (e) { return []; }
  }

  // ─── Eventos custom para que otros modulos sepan cuando cambia ───
  function emit(containerId, values) {
    document.dispatchEvent(new CustomEvent('apollo-icp-change', {
      detail: { container: containerId, values: values }
    }));
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // ─── API publica ─────────────────────────────────────────
  global.apolloChips = {
    getSelected(containerId) { return state[containerId] || []; },
    setSelected(containerId, values) {
      state[containerId] = Array.isArray(values) ? values : [];
      saveState();
    },
    clear(containerId) {
      delete state[containerId];
      saveState();
    },
    clearAll() {
      state = {};
      saveState();
    },
    renderChips: renderChips,
    renderGroupedChips: renderGroupedChips,
    attachAutocomplete: attachAutocomplete,
    addChipToContainer: addChipToContainer,

    // Llena TODOS los containers del ICP Builder de una sola vez
    populateICPBuilder() {
      if (!global.APOLLO_ENUMS) {
        console.warn('[apollo-icp-chips] APOLLO_ENUMS no esta cargado todavia');
        return;
      }
      const E = global.APOLLO_ENUMS;

      renderChips('icp-mgmt-level',  E.seniorities,        'select');
      renderChips('icp-departments', E.departments,        'select');
      renderChips('icp-locations',   E.countries,          'select');
      renderChips('icp-employees',   E.employee_ranges,    'select');
      renderGroupedChips('icp-industries', E.industries,   'select');

      // Autocomplete fields (los inputs deben existir en el HTML)
      attachAutocomplete('icp-tech-input',          'icp-tech-active',  'tech',    'select');
      attachAutocomplete('icp-company-input',       'icp-company-list', 'company', 'select');
      attachAutocomplete('icp-exclude-comp-input',  'icp-exclude-list', 'company', 'exclude');

      console.log('[apollo-icp-chips] ICP Builder populado');
    }
  };

  // Auto-popular cuando el DOM esta listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => global.apolloChips.populateICPBuilder());
  } else {
    setTimeout(() => global.apolloChips.populateICPBuilder(), 100);
  }
})(window);
