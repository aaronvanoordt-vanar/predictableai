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
      info:    { bg: "rgba(79,142,247,.12)", bd: "#4F8EF7", fg: "#E8EDF8" },
      success: { bg: "rgba(16,185,129,.12)", bd: "#10B981", fg: "#E8EDF8" },
      error:   { bg: "rgba(239,68,68,.12)",  bd: "#EF4444", fg: "#E8EDF8" },
      warn:    { bg: "rgba(245,158,11,.12)", bd: "#F59E0B", fg: "#E8EDF8" },
    }[type] || { bg: "#0D1424", bd: "#1E2D47", fg: "#E8EDF8" };

    const t = document.createElement("div");
    t.style.cssText = `
      background:${colors.bg}; border:1px solid ${colors.bd};
      color:${colors.fg}; padding:12px 14px; border-radius:10px;
      font-size:13px; line-height:1.5;
      box-shadow:0 4px 16px rgba(0,0,0,.4);
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
      background:rgba(239,68,68,.08); border:1px solid rgba(239,68,68,.3);
      color:#EF4444; padding:12px 14px; border-radius:10px;
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
