// js/ui-helpers.js
// ───────────────────────────────────────────────────────────
// Helpers UI: loading, error, toast, disable buttons.
// Mantiene el look & feel del HTML existente.
// ───────────────────────────────────────────────────────────
(function (global) {
  // Toast container
  function ensureToastContainer() {
    let c = document.getElementById("px-toasts");
    if (c) return c;
    c = document.createElement("div");
    c.id = "px-toasts";
    c.style.cssText = `
      position:fixed; right:20px; bottom:20px; z-index:9999;
      display:flex; flex-direction:column; gap:10px; max-width:340px;`;
    document.body.appendChild(c);
    return c;
  }

  function toast(message, type = "info") {
    const container = ensureToastContainer();
    const colors = {
      info:    { bg: "#EEF2FF", bd: "rgba(31,75,255,.30)",  fg: "#1A3FD6" },
      success: { bg: "#E9F7F0", bd: "rgba(14,169,104,.35)", fg: "#0B7F4F" },
      error:   { bg: "#FBEDED", bd: "rgba(214,69,69,.35)",  fg: "#B03A3A" },
      warn:    { bg: "#FBF3E4", bd: "rgba(199,126,18,.35)", fg: "#96610E" },
    }[type] || { bg: "#FFFFFF", bd: "rgba(10,10,15,.12)", fg: "#0A0A0F" };

    const t = document.createElement("div");
    t.style.cssText = `
      background:${colors.bg}; border:1px solid ${colors.bd};
      color:${colors.fg}; padding:12px 14px; border-radius:10px;
      font-size:13px; line-height:1.5;
      box-shadow:0 4px 16px rgba(10,10,15,.14);
      animation: fadeIn .25s ease;`;
    t.textContent = message;
    container.appendChild(t);

    setTimeout(() => {
      t.style.opacity = "0";
      t.style.transition = "opacity .3s";
      setTimeout(() => t.remove(), 300);
    }, 4500);
  }

  function setButtonLoading(btn, loadingText = "⏳ Cargando...") {
    if (!btn) return () => {};
    const original = btn.innerHTML;
    const wasDisabled = btn.disabled;
    btn.dataset._origBg = btn.style.background || "";
    btn.innerHTML = loadingText;
    btn.disabled = true;
    btn.style.opacity = "0.7";
    return function restore(finalText, finalBg) {
      btn.innerHTML = finalText || original;
      btn.disabled = wasDisabled;
      btn.style.opacity = "";
      if (finalBg) btn.style.background = finalBg;
      else btn.style.background = btn.dataset._origBg || "";
    };
  }

  function showErrorInline(container, err) {
    if (!container) return;
    const div = document.createElement("div");
    div.style.cssText = `
      background:#FBEDED; border:1px solid rgba(214,69,69,.35);
      color:#B03A3A; padding:12px 14px; border-radius:10px;
      font-size:13px; margin-top:12px;`;
    div.textContent = "⚠ " + (err?.message || err || "Error inesperado");
    container.appendChild(div);
    setTimeout(() => div.remove(), 8000);
  }

  // Helpers para leer <select multiple>
  function getMultiSelectValues(selectEl) {
    if (!selectEl) return [];
    return Array.from(selectEl.selectedOptions).map((o) => o.value.trim()).filter(Boolean);
  }

  // Helper para leer texto separado por coma
  function csv(str) {
    if (!str) return [];
    return String(str).split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Escapa texto antes de inyectarlo en innerHTML — previene XSS cuando se
  // renderiza data de Apollo / Supabase / LLM / localStorage con template strings.
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Devuelve una URL segura para usar en href/src, o '#' si el esquema no es
  // http(s)/mailto/tel — bloquea javascript:, data:, vbscript:, etc.
  function safeUrl(u) {
    const raw = String(u == null ? "" : u).trim();
    if (!raw) return "#";
    if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
    if (/^[/#.]/.test(raw) || /^[\w.-]+(\/|$)/.test(raw)) return raw; // relativa
    return "#";
  }

  global.escHtml = escHtml;
  global.safeUrl = safeUrl;

  global.uiHelpers = {
    toast,
    setButtonLoading,
    showErrorInline,
    getMultiSelectValues,
    csv,
    escHtml,
    safeUrl,
  };
})(window);
