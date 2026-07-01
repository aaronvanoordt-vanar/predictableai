// js/api.js
// ───────────────────────────────────────────────────────────
// Wrapper único para hablar con el backend Apps Script.
// Usa text/plain a propósito para evitar CORS preflight.
// ───────────────────────────────────────────────────────────
(function (global) {
  const cfg = global.PREDICTABLE_CONFIG || {};

  async function call(action, payload = {}) {
    if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.includes("XXXXXX")) {
      throw new Error("APPS_SCRIPT_URL no configurado en js/config.js");
    }

    // Atribuir la acción al usuario realmente autenticado, no a un email fijo.
    const authedEmail =
      (global.currentProfile && global.currentProfile.email) ||
      (global.currentUser && global.currentUser.email) ||
      cfg.CURRENT_USER_EMAIL ||
      null;

    const body = JSON.stringify({
      action,
      payload,
      user_email: authedEmail,
      ts: new Date().toISOString(),
    });

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      cfg.REQUEST_TIMEOUT_MS || 60000
    );

    try {
      const res = await fetch(cfg.APPS_SCRIPT_URL, {
        method: "POST",
        // text/plain evita preflight CORS con Apps Script
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const json = await res.json();

      if (!json.ok) {
        throw new Error(json.error || "Error desconocido del backend");
      }
      return json.data;
    } catch (err) {
      clearTimeout(timeout);
      console.error(`[api.${action}]`, err);
      throw err;
    }
  }

  // ── API pública ────────────────────────────────────────────
  global.api = {
    // Guarda / upsert del ICP en Sheets
    saveICP: (icp) => call("saveICP", { icp }),

    // Lanza búsqueda Apollo mixed_people/search
    // payload = { icp_id?, filters: {...mapeado Apollo} }
    searchApolloPeople: (payload) => call("searchApolloPeople", payload),

    // Lista secuencias activas en Apollo (emailer_campaigns)
    searchApolloSequences: () => call("searchApolloSequences", {}),

    // Toma lista de personas Apollo → crea contactos → los mete a secuencia
    // payload = { run_id, sequence_id, apollo_person_ids, send_email_from_email_account_id? }
    addContactsToSequence: (payload) =>
      call("addContactsToSequence", payload),

    // Healthcheck opcional
    ping: () => call("ping", {}),
     // ── Ventas AI ──
    startMeeting:     (p) => call('startMeeting', p),
    getMeetingState:  (p) => call('getMeetingState', p),
    endMeeting:       (p) => call('endMeeting', p),
    getSDRReport:     (p) => call('getSDRReport', p),
    ingestLocalChunks: (p) => call('ingestLocalChunks', p),
    ingestLocalEvent:  (p) => call('ingestLocalEvent', p),

    getLastMeetingReport: (p) => call('getLastMeetingReport', p || {}),


  };
})(window);
