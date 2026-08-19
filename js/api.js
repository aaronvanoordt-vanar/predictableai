// js/api.js
// ───────────────────────────────────────────────────────────
// Wrapper único para hablar con el backend del Meeting Coach:
// el edge function `sales-coach` de Supabase (reemplaza al
// antiguo Apps Script). Autentica con el JWT de la sesión
// Supabase; el backend identifica al usuario por el token.
// ───────────────────────────────────────────────────────────
(function (global) {
  const cfg = global.PREDICTABLE_CONFIG || {};

  function salesCoachUrl() {
    const sup = global.SUPABASE_CONFIG || {};
    if (!sup.url) {
      throw new Error("SUPABASE_CONFIG.url no configurado en js/config.js");
    }
    return sup.url.replace(/\/$/, "") + "/functions/v1/sales-coach";
  }

  async function getAccessToken() {
    const sb = global.supabaseClient;
    if (!sb) throw new Error("Supabase no está inicializado. Recarga la página.");
    const { data } = await sb.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) throw new Error("Sesión expirada. Vuelve a iniciar sesión.");
    return token;
  }

  async function call(action, payload = {}) {
    const url = salesCoachUrl();
    const token = await getAccessToken();
    const anonKey = (global.SUPABASE_CONFIG && global.SUPABASE_CONFIG.anonKey) || "";

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      cfg.REQUEST_TIMEOUT_MS || 60000
    );

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          apikey: anonKey,
        },
        body: JSON.stringify({ action, payload }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      let json = null;
      try { json = await res.json(); } catch (_) { /* respuesta no-JSON */ }

      if (!res.ok) {
        const detail = (json && (json.error || json.message)) || (res.status + " " + res.statusText);
        throw new Error(
          res.status === 401
            ? "Sesión expirada. Vuelve a iniciar sesión."
            : "Error del backend (" + detail + ")"
        );
      }

      if (!json || json.ok !== true) {
        throw new Error((json && json.error) || "Error desconocido del backend");
      }
      return json.data;
    } catch (err) {
      clearTimeout(timeout);
      console.error(`[api.${action}]`, err);
      throw err;
    }
  }

  // ── API pública ────────────────────────────────────────────
  // Nota: los wrappers de Apollo/ICP del viejo Apps Script
  // (saveICP, searchApolloPeople, searchApolloSequences,
  // addContactsToSequence) fueron eliminados — esas rutas viven
  // ahora en Supabase (apollo-proxy vía js/prospecting-data.js).
  global.api = {
    // Healthcheck
    ping: () => call("ping", {}),

    // ── Ventas AI (Meeting Coach) ──
    startMeeting:      (p) => call("startMeeting", p),
    getMeetingState:   (p) => call("getMeetingState", p),
    endMeeting:        (p) => call("endMeeting", p),
    getSDRReport:      (p) => call("getSDRReport", p),
    ingestLocalChunks: (p) => call("ingestLocalChunks", p),
    ingestLocalEvent:  (p) => call("ingestLocalEvent", p),

    getLastMeetingReport: (p) => call("getLastMeetingReport", p || {}),

    // Resultado de la reunión (ganado/perdido/seguimiento/sin_respuesta)
    setMeetingOutcome: (p) => call("setMeetingOutcome", p),

    // Objeciones agregadas (el backend decide el alcance según rol:
    // SDR = propias, admin/director = todo el equipo)
    getObjectionsReport: (p) => call("getObjectionsReport", p || {}),

    // Un turno de coaching en vivo resuelto en el backend, para cuando el
    // motor de IA elegido no es OpenAI (el worker solo habla con OpenAI).
    coachTurn: (p) => call("coachTurn", p || {}),
  };
})(window);
