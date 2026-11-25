// js/lead-sources.js
// ═══════════════════════════════════════════════════════════
// Fuentes del lead (2026-11-25, feedback de cliente).
//
// No todos los leads tienen LinkedIn o web. En Listas → Investigación el
// vendedor agrega aquí otros enlaces útiles o material (presentaciones
// ejecutivas, PDF, Word, imágenes) sobre la persona o su empresa. El AI Sales
// Coach y la investigación con IA lo leen (buildCoachLeadContext /
// lead-research).
//
//  • Se guardan en `prospect_list_members.sources` (arreglo JSON, tope 12) y
//    los archivos en el bucket privado `lead-sources` (URL firmada al abrir).
//  • El texto de PDF, Word y PowerPoint se extrae EN EL NAVEGADOR y se guarda
//    acotado junto a la fuente: es lo que lee la IA. De una imagen la IA solo
//    lee el título y la nota que escribas (y la interfaz lo dice).
//  • «Agregar también a las demás personas de la empresa» copia la fuente a
//    los otros contactos de esa empresa en la misma lista.
//
// Lo monta js/prospecting.js en cada [data-lead-sources="<member_id>"]. Todo
// texto del usuario entra al DOM con textContent.
// ═══════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var MAX_SOURCES = 12;
  var MAX_TEXT = 12000;                 // caracteres de texto extraído por fuente
  var MAX_FILE = 25 * 1024 * 1024;
  var BUCKET = 'lead-sources';
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
  // Mismos lectores y la misma integridad que js/campaign-knowledge.js.
  var SRI = {};
  SRI[PDFJS] = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
  SRI[MAMMOTH] = 'sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz';
  var MIME = {
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  };

  var hooks = { find: null, peers: null };   // los da js/prospecting.js
  var drafts = {};                            // member id → { url, title, note, peers } (sobrevive a un repintado)
  var busy = {};                              // member id → texto de estado

  function sb() { return global.supabaseClient; }
  function pd() { return global.prospectingData; }
  function toast(msg, type) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info'); }
  function uid() { return (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function listOf(m) { return Array.isArray(m && m.sources) ? m.sources.filter(function (x) { return x && typeof x === 'object'; }) : []; }
  function extOf(name) { var x = /\.([a-z0-9]+)$/i.exec(String(name || '')); return x ? x[1].toLowerCase() : ''; }
  function safeUrl(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try { var p = new URL(s); return (p.protocol === 'https:' || p.protocol === 'http:') && p.hostname.indexOf('.') !== -1 ? p.href : ''; }
    catch (e) { return ''; }
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((n || 0) / 1024)) + ' KB'; }

  // ── Lectura de archivos (en el navegador) ───────────────────────────────
  var scriptPromises = {};
  function loadScript(src) {
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src; s.async = true;
        if (SRI[src]) { s.integrity = SRI[src]; s.crossOrigin = 'anonymous'; }
        s.onload = resolve;
        s.onerror = function () { delete scriptPromises[src]; reject(new Error('No se pudo cargar el lector de archivos. Revisa tu conexión.')); };
        document.head.appendChild(s);
      });
    }
    return scriptPromises[src];
  }
  async function extractPdf(file) {
    await loadScript(PDFJS);
    var lib = global.pdfjsLib;
    if (!lib) throw new Error('No se pudo cargar el lector de PDF.');
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    var pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    var pages = [];
    for (var i = 1; i <= Math.min(pdf.numPages, 80); i++) {
      var tc = await (await pdf.getPage(i)).getTextContent();
      pages.push(tc.items.map(function (it) { return it.str + (it.hasEOL ? '\n' : ' '); }).join('').replace(/[ \t]+/g, ' ').trim());
    }
    return pages.filter(Boolean).join('\n\n');
  }
  async function extractDocx(file) {
    await loadScript(MAMMOTH);
    if (!global.mammoth) throw new Error('No se pudo cargar el lector de Word.');
    var r = await global.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return String(r.value || '').replace(/\n{3,}/g, '\n\n').trim();
  }
  // Un .pptx es un ZIP con un XML por diapositiva. Se lee el índice del ZIP y
  // se descomprime cada diapositiva con DecompressionStream (nativo): sin
  // librerías de terceros.
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('Tu navegador no puede leer presentaciones. El archivo se guarda igual: describe su contenido en la nota.');
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function extractPptx(file) {
    var buf = new Uint8Array(await file.arrayBuffer());
    var dv = new DataView(buf.buffer);
    var eocd = -1;
    for (var i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('El archivo no es una presentación válida.');
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    var dec = new TextDecoder('utf-8');
    var slides = [];
    for (var n = 0; n < count && off + 46 <= buf.length; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var method = dv.getUint16(off + 10, true);
      var csize = dv.getUint32(off + 20, true);
      var nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      var local = dv.getUint32(off + 42, true);
      var name = dec.decode(buf.subarray(off + 46, off + 46 + nlen));
      var mm = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
      if (mm && local + 30 <= buf.length) {
        var lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
        var start = local + 30 + lnlen + lxlen;
        slides.push({ n: parseInt(mm[1], 10), method: method, data: buf.subarray(start, start + csize) });
      }
      off += 46 + nlen + xlen + clen;
    }
    slides.sort(function (a, b) { return a.n - b.n; });
    var out = [];
    for (var k = 0; k < slides.length && k < 80; k++) {
      var s = slides[k];
      var raw = s.method === 0 ? s.data : s.method === 8 ? await inflateRaw(s.data) : null;
      if (!raw) continue;
      var xml = dec.decode(raw);
      var parts = [];
      xml.replace(/<a:t[^>]*>([^<]*)<\/a:t>/g, function (_, t) { parts.push(t); return ''; });
      var text = parts.join(' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
      if (text) out.push('Diapositiva ' + s.n + ': ' + text);
    }
    return out.join('\n');
  }
  /** Texto del archivo, o '' si es una imagen o no trae texto. Lanza si el formato no se acepta. */
  async function extractText(file) {
    var ext = extOf(file.name);
    if (!MIME[ext]) throw new Error('Formato no aceptado. Sube PDF, PowerPoint (.pptx), Word (.docx) o una imagen (PNG, JPG, WebP).');
    if (file.size > MAX_FILE) throw new Error('El archivo pesa más de 25 MB.');
    if (ext === 'pdf') return extractPdf(file);
    if (ext === 'docx') return extractDocx(file);
    if (ext === 'pptx') return extractPptx(file);
    return '';
  }

  // ── Guardar ─────────────────────────────────────────────────────────────
  async function persist(m, next) {
    if (next.length > MAX_SOURCES) throw new Error('Cada lead admite hasta ' + MAX_SOURCES + ' fuentes. Quita una para agregar otra.');
    await pd().updateMember(m.id, { sources: next });
    m.sources = next;
  }
  async function addSource(m, src, withPeers) {
    await persist(m, listOf(m).concat([src]));
    var copied = 0;
    if (withPeers && hooks.peers) {
      var peers = hooks.peers(m) || [];
      for (var i = 0; i < peers.length; i++) {
        var p = peers[i];
        if (listOf(p).length >= MAX_SOURCES) continue;
        // La copia apunta al mismo archivo: `shared` evita que borrar una lo deje huérfano en las demás.
        try { await persist(p, listOf(p).concat([Object.assign({}, src, { id: uid(), shared: true })])); copied++; }
        catch (e) { console.warn('[lead-sources] copia a un compañero de empresa:', e && e.message); }
      }
      if (copied) { src.shared = true; await persist(m, listOf(m)); }
    }
    return copied;
  }

  async function onAddLink(m, host) {
    var d = drafts[m.id] || {};
    var url = safeUrl(d.url);
    if (!url) { toast('Escribe un enlace válido (por ejemplo, https://empresa.com/presentacion).', 'warn'); return; }
    if (listOf(m).some(function (x) { return x.url === url; })) { toast('Ese enlace ya está en las fuentes de este lead.', 'warn'); return; }
    busy[m.id] = 'Guardando…'; render(host, m);
    try {
      var copied = await addSource(m, {
        id: uid(), kind: 'link', url: url,
        title: String(d.title || '').trim().slice(0, 140) || hostOf(url),
        note: String(d.note || '').trim().slice(0, 600) || null,
        added_at: new Date().toISOString(),
      }, !!d.peers);
      drafts[m.id] = { peers: d.peers };
      toast(copied ? 'Fuente agregada a este lead y a ' + copied + ' más de la empresa.' : 'Fuente agregada.', 'success');
    } catch (e) {
      toast(saveError(e), 'error');
    } finally { delete busy[m.id]; render(host, m); }
  }

  async function onAddFile(m, host, file) {
    if (!file) return;
    var d = drafts[m.id] || {};
    busy[m.id] = 'Leyendo el archivo…'; render(host, m);
    try {
      var text = '';
      var readNote = '';
      try { text = await extractText(file); }
      catch (e) {
        // Formato o tamaño no aceptado: no se sube. Un fallo del lector sí deja subir.
        if (!MIME[extOf(file.name)] || file.size > MAX_FILE) throw e;
        readNote = e && e.message ? e.message : '';
      }
      busy[m.id] = 'Subiendo…'; render(host, m);
      var userId = (global.currentUser && global.currentUser.id) || (await sb().auth.getUser()).data.user.id;
      var ext = extOf(file.name);
      var clean = String(file.name || 'archivo').replace(/[^\w.\-]+/g, '_').slice(-80);
      var path = userId + '/' + m.id + '/' + uid() + '-' + clean;
      var up = await sb().storage.from(BUCKET).upload(path, file, { contentType: MIME[ext], upsert: false });
      if (up.error) throw new Error(up.error.message);
      var isImage = /^image\//.test(MIME[ext]);
      var copied = await addSource(m, {
        id: uid(), kind: 'file', path: path, mime: MIME[ext], size: file.size,
        title: String(d.title || '').trim().slice(0, 140) || String(file.name || 'Archivo').slice(0, 140),
        note: String(d.note || '').trim().slice(0, 600) || null,
        text: text ? text.slice(0, MAX_TEXT) : null,
        truncated: text.length > MAX_TEXT || undefined,
        added_at: new Date().toISOString(),
      }, !!d.peers);
      drafts[m.id] = { peers: d.peers };
      if (readNote) toast(readNote, 'warn');
      else if (isImage) toast('Imagen guardada. La IA no ve imágenes: escribe en la nota lo que muestra.', 'info');
      else if (!text) toast('Archivo guardado, pero no se pudo leer texto (¿son diapositivas en imagen?). Escribe en la nota lo importante.', 'warn');
      else toast(copied ? 'Archivo agregado a este lead y a ' + copied + ' más de la empresa.' : 'Archivo agregado: la IA ya puede leerlo.', 'success');
    } catch (e) {
      toast(saveError(e), 'error');
    } finally { delete busy[m.id]; render(host, m); }
  }

  function saveError(e) {
    var msg = e && e.message ? e.message : 'error';
    if (/sources|column|schema cache|bucket|not found/i.test(msg)) return 'Las fuentes todavía no están activadas en el servidor. Inténtalo en unos minutos.';
    return msg;
  }

  async function onRemove(m, host, id) {
    var src = listOf(m).filter(function (x) { return x.id === id; })[0];
    if (!src) return;
    busy[m.id] = 'Quitando…'; render(host, m);
    try {
      await persist(m, listOf(m).filter(function (x) { return x.id !== id; }));
      // El archivo solo se borra si ninguna otra persona lo comparte.
      if (src.kind === 'file' && src.path && !src.shared) {
        try { await sb().storage.from(BUCKET).remove([src.path]); } catch (e) { /* queda huérfano, sin acceso público */ }
      }
    } catch (e) { toast(saveError(e), 'error'); }
    finally { delete busy[m.id]; render(host, m); }
  }

  async function onOpenFile(src) {
    // La pestaña se abre dentro del clic (si no, el navegador la bloquea) y se apunta cuando llega la URL firmada.
    var w = global.open('about:blank', '_blank');
    try {
      var r = await sb().storage.from(BUCKET).createSignedUrl(src.path, 300);
      if (r.error || !r.data || !r.data.signedUrl) throw new Error(r.error ? r.error.message : 'sin enlace');
      if (w) { w.opener = null; w.location.href = r.data.signedUrl; }
    } catch (e) {
      if (w) w.close();
      toast('No se pudo abrir el archivo. Reintenta.', 'error');
    }
  }

  // ── Pintar ──────────────────────────────────────────────────────────────
  function render(host, m) {
    if (!host || !m) return;
    var id = String(m.id);
    var d = drafts[id] = drafts[id] || {};
    var items = listOf(m);
    host.textContent = '';
    host.className = 'lsrc';

    var head = el('div', 'pros-research-head');
    head.style.marginTop = '10px';
    head.appendChild(el('span', 'pros-lbl', 'Fuentes del lead'));
    if (busy[id]) head.appendChild(el('span', 'pros-cellsub', busy[id]));
    host.appendChild(head);

    var box = el('div', 'pros-research-sec');
    if (!items.length) {
      box.appendChild(el('div', 'lsrc-empty', 'Agrega enlaces o material de esta persona o de su empresa (una presentación ejecutiva, un PDF, una nota de prensa). El AI Sales Coach y la investigación con IA lo usan para entenderla mejor, también cuando no tiene LinkedIn ni web.'));
    }
    items.forEach(function (src) {
      var row = el('div', 'lsrc-row');
      var main = el('div', 'lsrc-main');
      var title;
      if (src.kind === 'link' && safeUrl(src.url)) {
        title = el('a', 'lsrc-title notranslate', src.title || hostOf(src.url));
        title.href = safeUrl(src.url); title.target = '_blank'; title.rel = 'noopener noreferrer';
      } else {
        title = el('button', 'lsrc-title lsrc-open notranslate', src.title || 'Archivo');
        title.type = 'button';
        title.addEventListener('click', function () { onOpenFile(src); });
      }
      main.appendChild(title);
      var meta = src.kind === 'link' ? hostOf(src.url)
        : [src.size ? fmtSize(src.size) : '', /^image\//.test(src.mime || '') ? 'Imagen: la IA lee solo tu nota' : src.text ? (src.truncated ? 'Texto leído (primeras páginas)' : 'Texto leído por la IA') : 'Sin texto legible: la IA lee solo tu nota'].filter(Boolean).join(' · ');
      main.appendChild(el('div', 'pros-cellsub', meta));
      if (src.note) main.appendChild(el('div', 'lsrc-note notranslate', src.note));
      row.appendChild(main);
      var del = el('button', 'btn btn-ghost btn-sm', 'Quitar');
      del.type = 'button';
      del.setAttribute('aria-label', 'Quitar la fuente ' + (src.title || ''));
      del.disabled = !!busy[id];
      del.addEventListener('click', function () { onRemove(m, host, src.id); });
      row.appendChild(del);
      box.appendChild(row);
    });

    if (items.length < MAX_SOURCES) {
      var form = el('div', 'lsrc-form');
      var input = function (ph, key, label) {
        var i = el('input', 'pros-input lsrc-in');
        i.type = 'text'; i.placeholder = ph; i.value = d[key] || '';
        i.setAttribute('aria-label', label);
        i.addEventListener('input', function () { d[key] = i.value; });
        return i;
      };
      var url = input('Enlace (https://…)', 'url', 'Enlace de la fuente');
      url.type = 'url';
      url.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); onAddLink(m, host); } });
      form.appendChild(url);
      form.appendChild(input('Título (opcional)', 'title', 'Título de la fuente'));
      form.appendChild(input('Nota: qué es y por qué importa (opcional)', 'note', 'Nota sobre la fuente'));

      var peers = hooks.peers ? (hooks.peers(m) || []) : [];
      if (peers.length && m.company) {
        var lab = el('label', 'lsrc-peers');
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!d.peers;
        cb.addEventListener('change', function () { d.peers = cb.checked; });
        lab.appendChild(cb);
        var span = el('span');
        span.appendChild(document.createTextNode(peers.length === 1 ? 'Agregar también a la otra persona de ' : 'Agregar también a las otras ' + peers.length + ' personas de '));
        span.appendChild(el('span', 'notranslate', m.company));
        span.appendChild(document.createTextNode(' en esta lista'));
        lab.appendChild(span);
        form.appendChild(lab);
      }

      var actions = el('div', 'lsrc-actions');
      var addLink = el('button', 'btn btn-ghost btn-sm', 'Agregar enlace');
      addLink.type = 'button'; addLink.disabled = !!busy[id];
      addLink.addEventListener('click', function () { onAddLink(m, host); });
      var file = el('input'); file.type = 'file'; file.hidden = true;
      file.accept = '.pdf,.pptx,.docx,.png,.jpg,.jpeg,.webp';
      file.addEventListener('change', function () { var f = file.files && file.files[0]; file.value = ''; onAddFile(m, host, f); });
      var addFile = el('button', 'btn btn-ghost btn-sm', 'Subir archivo');
      addFile.type = 'button'; addFile.disabled = !!busy[id];
      addFile.addEventListener('click', function () { file.click(); });
      actions.appendChild(addLink); actions.appendChild(addFile); actions.appendChild(file);
      form.appendChild(actions);
      form.appendChild(el('div', 'pros-cellsub', 'PDF, PowerPoint (.pptx), Word (.docx) o imagen, hasta 25 MB. El título y la nota de arriba se aplican a lo que agregues.'));
      box.appendChild(form);
    } else {
      box.appendChild(el('div', 'pros-cellsub', 'Llegaste al tope de ' + MAX_SOURCES + ' fuentes por lead.'));
    }
    host.appendChild(box);
  }

  /** Pinta la sección en cada [data-lead-sources] de `root`. `opts.find(id)` da la fila; `opts.peers(m)`, los demás de su empresa. */
  function mountAll(root, opts) {
    if (opts) { hooks.find = opts.find || hooks.find; hooks.peers = opts.peers || hooks.peers; }
    injectCss();
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-lead-sources]'), function (host) {
      var m = hooks.find && hooks.find(host.getAttribute('data-lead-sources'));
      if (m) render(host, m);
    });
  }

  /**
   * Lo que el coach lee de las fuentes de un lead: título, enlace, nota y un
   * extracto del texto. Acotado (`max` caracteres). Sin fuentes, null.
   */
  function textFor(m, max) {
    var items = listOf(m);
    if (!items.length) return null;
    var budget = max || 1800;
    var out = [];
    items.forEach(function (s) {
      if (budget <= 80) return;
      var head = '• ' + String(s.title || (s.kind === 'link' ? hostOf(s.url) : 'Archivo')).slice(0, 120) +
        (s.kind === 'link' && s.url ? ' (' + String(s.url).slice(0, 200) + ')' : '') +
        (s.note ? ' — ' + String(s.note).slice(0, 300) : '');
      head = head.slice(0, budget);
      budget -= head.length;
      out.push(head);
      if (s.text && budget > 120) {
        var take = String(s.text).replace(/\s+/g, ' ').slice(0, Math.min(700, budget));
        budget -= take.length;
        out.push('  ' + take);
      }
    });
    return out.length ? out.join('\n') : null;
  }

  function injectCss() {
    if (document.getElementById('lsrc-css')) return;
    var st = document.createElement('style');
    st.id = 'lsrc-css';
    st.textContent =
      '.lsrc-empty{color:var(--text3)}' +
      '.lsrc-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0}' +
      '.lsrc-row+.lsrc-row{border-top:1px dashed var(--border)}' +
      '.lsrc-main{flex:1;min-width:0}' +
      '.lsrc-title{font-size:13px;font-weight:600;color:var(--accent-ink);overflow-wrap:anywhere;text-align:left}' +
      '.lsrc-open{background:none;border:0;padding:0;font-family:inherit;cursor:pointer}' +
      '.lsrc-open:hover,a.lsrc-title:hover{text-decoration:underline}' +
      '.lsrc-open:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}' +
      '.lsrc-note{font-size:12.5px;color:var(--text2);margin-top:3px;white-space:pre-line;overflow-wrap:anywhere}' +
      '.lsrc-form{display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}' +
      '.lsrc-row~.lsrc-form,.lsrc-empty~.lsrc-form{margin-top:10px}' +
      '.lsrc-in{width:100%;box-sizing:border-box;font-size:12.5px;padding:7px 10px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);color:var(--text)}' +
      '.lsrc-peers{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--text2);text-transform:none;letter-spacing:0;font-family:inherit;font-weight:400;cursor:pointer}' +
      '.lsrc-peers input{margin-top:2px;accent-color:var(--accent)}' +
      '.lsrc-actions{display:flex;gap:8px;flex-wrap:wrap}';
    document.head.appendChild(st);
  }

  global.LeadSources = { mountAll: mountAll, textFor: textFor, MAX: MAX_SOURCES };
})(window);
