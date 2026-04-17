// js/apollo-sequences.js
// ───────────────────────────────────────────────────────────
// Conecta la página Apollo Sequences (#page-pro-apollo) al
// backend: mapeo ICP→Apollo, búsqueda, render, selección y
// envío a secuencia.
// ───────────────────────────────────────────────────────────
(function (global) {
  const { toast, setButtonLoading, csv } = global.uiHelpers;

  let lastRunId = null;
  let lastResults = [];
  let sequencesCache = [];

  // ── Mapeo ICP (UI) → filtros Apollo ────────────────────────
  // Esta función convierte lo que hay en los inputs del ICP
  // (o los del formulario de Apollo) a los params reales que
  // acepta Apollo mixed_people/search.
  function buildApolloFilters() {
    const root = document.getElementById("page-pro-apollo");
    const q = (key) => root.querySelector(`[data-apollo="${key}"]`);

    // Leemos los inputs de la página Apollo (que arrancan pre-cargados desde ICP)
    const titles      = csv(q("titles")?.value);
    const industries  = csv(q("industries")?.value);
    const countries   = csv(q("countries")?.value);
    const sizesRange  = (q("company_sizes")?.value || "").trim(); // "11-200"
    const keywords    = csv(q("keywords")?.value);
    const seqSelected = q("sequence_dest")?.value || "";

    // Apollo acepta tamaños como ["1,10","11,50","51,200",...]
    const ranges = sizesRangeToApollo(sizesRange);

    return {
      // ── filtros Apollo reales ────────────────────────────
      person_titles: titles,                                  // Apollo: person_titles[]
      person_locations: countries,                            // Apollo: person_locations[] (país)
      organization_num_employees_ranges: ranges,              // Apollo: organization_num_employees_ranges[]
      q_organization_keyword_tags: industries,                // Apollo: industrias por keyword
      q_keywords: keywords.join(" "),                         // búsqueda libre
      page: 1,
      per_page: (global.PREDICTABLE_CONFIG?.APOLLO_DEFAULT_PER_PAGE) || 25,

      // contexto para guardar en Sheets
      _meta: {
        sequence_dest: seqSelected,
        icp_id: global.predictable?.currentICP?.icp_id || null,
      },
    };
  }

  // "11-200" → ["11,50","51,200"] o custom split
  // Apollo acepta rangos estándar: 1,10 / 11,20 / 21,50 / 51,100 / 101,200 /
  //                                201,500 / 501,1000 / 1001,2000 / 2001,5000 / 5001,10000 / 10001+
  function sizesRangeToApollo(raw) {
    if (!raw) return [];
    const [min, max] = raw.split("-").map((s) => parseInt(s.trim(), 10));
    if (isNaN(min) || isNaN(max)) return [];

    const apolloRanges = [
      [1, 10], [11, 20], [21, 50], [51, 100], [101, 200],
      [201, 500], [501, 1000], [1001, 2000], [2001, 5000],
      [5001, 10000], [10001, 999999],
    ];
    return apolloRanges
      .filter(([a, b]) => b >= min && a <= max)
      .map(([a, b]) => `${a},${b === 999999 ? 10001 : b}`);
  }

  // ── Acción principal: buscar en Apollo ─────────────────────
  async function runSearch(triggerBtn) {
    const filters = buildApolloFilters();
    const restore = setButtonLoading(triggerBtn, "⏳ Buscando en Apollo...");

    try {
      const res = await global.api.searchApolloPeople(filters);
      // res = { run_id, results_count, people: [...] }

      lastRunId = res.run_id;
      lastResults = res.people || [];

      renderResults(lastResults, res.results_count);
      // Steps: [0] ICP done, [1] Búsqueda (activa→done), [2] Enrichment (auto done), [3] Asignar (ahora activa)
      markStepDone(1);
      markStepDone(2);
      markStepActive(3);
      restore(`✓ ${res.results_count} contactos encontrados`,
              "var(--gradient-green)");
      toast(`✓ ${res.results_count} contactos encontrados`, "success");
    } catch (e) {
      toast("Error buscando en Apollo: " + e.message, "error");
      restore();
    }
  }

  // ── Renderizar resultados en la tabla ──────────────────────
  function renderResults(people, totalCount) {
    const container = document.getElementById("apollo-results");
    if (!container) return;
    container.style.display = "block";

    const tbody = container.querySelector("tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    people.forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" data-apollo-person-id="${escapeHTML(p.id)}"
                   style="accent-color:var(--purple)">
            <strong>${escapeHTML(p.name || "(sin nombre)")}</strong>
          </label>
        </td>
        <td>${escapeHTML(p.title || "—")}</td>
        <td>${escapeHTML(p.organization_name || "—")}</td>
        <td>${escapeHTML(p.country || "—")}</td>
        <td>${p.email ? "✓ " + escapeHTML(p.email) : "—"}</td>
        <td>${renderScore(p.score_icp)}</td>
      `;
      tbody.appendChild(tr);
    });

    const more = Math.max(0, (totalCount || people.length) - people.length);
    if (more > 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" style="text-align:center;color:var(--text3);font-size:12px">
        ... y ${more} más (no mostrados en esta página)
      </td>`;
      tbody.appendChild(tr);
    }

    // Update header count
    const head = container.querySelector(".table-head span");
    if (head) head.textContent = `Resultados · ${totalCount || people.length} contactos`;

    // Bind "Agregar a secuencia" button
    const addBtn = container.querySelector(".btn-purple");
    if (addBtn) {
      addBtn.onclick = () => addSelectedToSequence(addBtn);
    }
    // Bind CSV export
    const csvBtn = container.querySelector(".btn-ghost");
    if (csvBtn) csvBtn.onclick = () => exportCSV(lastResults);
  }

  function renderScore(score) {
    if (score == null) return "—";
    const color =
      score >= 85 ? "pill-green" :
      score >= 70 ? "pill-blue"  :
      score >= 55 ? "pill-amber" : "pill-red";
    return `<span class="pill ${color}">${score}</span>`;
  }

  function escapeHTML(s) {
    return String(s ?? "").replace(/[&<>"']/g,
      (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  // ── Mandar seleccionados a secuencia ───────────────────────
  async function addSelectedToSequence(btn) {
    const selected = Array.from(
      document.querySelectorAll("#apollo-results [data-apollo-person-id]:checked")
    ).map((cb) => cb.dataset.apolloPersonId);

    if (!selected.length) {
      toast("Selecciona al menos un contacto", "warn");
      return;
    }

    // Conseguir sequence_id destino
    let sequenceId = await resolveSequenceId();
    if (!sequenceId) {
      toast("No hay secuencia destino válida", "error");
      return;
    }

    const restore = setButtonLoading(btn, "⏳ Agregando...");
    try {
      const res = await global.api.addContactsToSequence({
        run_id: lastRunId,
        sequence_id: sequenceId,
        apollo_person_ids: selected,
      });
      // res = { added: N, failed: [..], sequence_id, sequence_name }

      toast(`✓ ${res.added} contactos agregados a "${res.sequence_name || sequenceId}"`, "success");
      if (res.failed?.length) {
        toast(`⚠ ${res.failed.length} fallaron (ver Sheets/logs)`, "warn");
      }
      restore(`✓ ${res.added} agregados`);
      // Asignar secuencia (idx 3) → done, Activar en respond.io (idx 4) → activa
      markStepDone(3);
      markStepActive(4);
    } catch (e) {
      toast("Error agregando a secuencia: " + e.message, "error");
      restore();
    }
  }

  async function resolveSequenceId() {
    const select = document.querySelector('#page-pro-apollo [data-apollo="sequence_dest"]');
    const val = select?.value || "";
    if (val && val.startsWith("seq_")) return val.replace("seq_", "");

    // Si no hay valor limpio, intentar resolver por nombre
    if (!sequencesCache.length) {
      try {
        sequencesCache = await global.api.searchApolloSequences();
      } catch (e) { /* ignore */ }
    }
    const match = sequencesCache.find((s) => s.name === val);
    return match?.id || null;
  }

  // ── Poblar el <select> de secuencias desde Apollo ──────────
  async function loadSequences() {
    const select = document.querySelector('#page-pro-apollo [data-apollo="sequence_dest"]');
    if (!select) return;
    try {
      sequencesCache = await global.api.searchApolloSequences();
      const current = select.value;
      select.innerHTML = "";
      sequencesCache.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = "seq_" + s.id;
        opt.textContent = s.name + (s.active ? "" : " (pausada)");
        if (s.name === current) opt.selected = true;
        select.appendChild(opt);
      });
      const create = document.createElement("option");
      create.value = "__create__";
      create.textContent = "+ Crear nueva secuencia en Apollo";
      select.appendChild(create);
    } catch (e) {
      console.warn("No se pudo cargar secuencias", e);
    }
  }

  // ── CSV export local (sin llamar al backend) ───────────────
  function exportCSV(people) {
    if (!people?.length) return;
    const headers = ["name","title","organization_name","country","email","score_icp","linkedin_url"];
    const rows = [headers.join(",")].concat(
      people.map((p) =>
        headers.map((h) => `"${String(p[h] ?? "").replace(/"/g, '""')}"`).join(",")
      )
    );
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `apollo_results_${lastRunId || Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // ── Avance visual de steps ─────────────────────────────────
  function steps() { return document.querySelectorAll("#page-pro-apollo .step"); }

  function markStepDone(idx) {
    const s = steps()[idx]; if (!s) return;
    s.classList.remove("active");
    s.classList.add("done");
    const n = s.querySelector(".step-num");
    if (n) n.textContent = "✓";
  }
  function markStepActive(idx) {
    const s = steps()[idx]; if (!s) return;
    s.classList.add("active");
  }

  // ── API pública del módulo ─────────────────────────────────
  global.apolloSequences = {
    runSearch,
    loadSequences,
    buildApolloFilters,
  };

  // Auto-carga de secuencias cuando el usuario entra al step
  document.addEventListener("DOMContentLoaded", () => {
    const tryLoad = () => {
      if (document.getElementById("page-pro-apollo")?.classList.contains("active")) {
        loadSequences();
      }
    };
    document.querySelectorAll('[data-page="pro-apollo"]').forEach((el) =>
      el.addEventListener("click", () => setTimeout(tryLoad, 200))
    );
  });
})(window);
