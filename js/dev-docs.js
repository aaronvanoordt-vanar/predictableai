/**
 * js/dev-docs.js — la documentación de la API de Predictable (2026-09-23).
 *
 * Pinta la referencia completa a partir de /openapi.json (el contrato
 * público, verificado contra el código por supabase/functions/_shared/
 * devapi.test.ts), así que la documentación nunca se escribe dos veces.
 * La usan:
 *   · la pestaña «Referencia» de Desarrolladores (js/developers.js), y
 *   · developers.html, la página pública que el cliente le pasa a su equipo
 *     técnico (sin login).
 *
 * API: DevDocs.load() → Promise<spec>;
 *      DevDocs.render(container, spec, { apiBase, mcpUrl }).
 * No depende de nada más que del DOM; todo texto del spec se escapa.
 */
(function (global) {
  'use strict';

  var CSS_ID = 'dd-css';
  var specPromise = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /** Markdown mínimo sobre texto YA escapado: párrafos, **negrita** y `código`. */
  function md(text) {
    return String(text || '').split(/\n{2,}/).map(function (p) {
      var h = esc(p).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
      return '<p>' + h.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  function load() {
    if (!specPromise) {
      specPromise = fetch('openapi.json', { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('No se pudo cargar openapi.json (' + r.status + ')');
        return r.json();
      }).catch(function (e) { specPromise = null; throw e; });
    }
    return specPromise;
  }

  // ─── Ejemplos generados desde el esquema ───────────────────────────────────
  function resolve(spec, s) {
    var guard = 0;
    while (s && s.$ref && guard++ < 10) {
      var parts = s.$ref.replace(/^#\//, '').split('/');
      s = parts.reduce(function (o, k) { return o && o[k]; }, spec);
    }
    return s || {};
  }

  function sample(spec, schema, depth) {
    var s = resolve(spec, schema);
    if (depth > 4) return null;
    if (s.example !== undefined) return s.example;
    if (s.allOf) {
      var merged = {};
      s.allOf.forEach(function (part) { var v = sample(spec, part, depth + 1); if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v); });
      return merged;
    }
    var type = Array.isArray(s.type) ? s.type.filter(function (t) { return t !== 'null'; })[0] : s.type;
    if (s.enum) return s.enum.filter(function (v) { return v !== null; })[0];
    if (type === 'object' || s.properties) {
      var out = {};
      Object.keys(s.properties || {}).forEach(function (k) { out[k] = sample(spec, s.properties[k], depth + 1); });
      return out;
    }
    if (type === 'array') { var it = sample(spec, s.items || {}, depth + 1); return it == null ? [] : [it]; }
    if (type === 'integer' || type === 'number') return s.default != null ? s.default : 0;
    if (type === 'boolean') return s.default != null ? s.default : false;
    if (s.format === 'uuid') return '3f2b8c1e-5a4d-4e7b-9c0a-1d2e3f4a5b6c';
    if (s.format === 'date-time') return '2026-09-23T15:04:05Z';
    if (s.format === 'date') return '2026-09-23';
    if (s.format === 'email') return 'ana@acme.com';
    if (s.format === 'uri') return 'https://crm.miempresa.com/hooks/predictable';
    if (type === 'string') return 'texto';
    return null;
  }

  function requestExample(spec, op) {
    var c = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
    if (!c) return null;
    return c.example !== undefined ? c.example : sample(spec, c.schema, 0);
  }

  function responseExample(spec, op) {
    var codes = Object.keys(op.responses || {}).filter(function (k) { return /^2/.test(k); }).sort();
    var r = codes.length && resolve(spec, op.responses[codes[0]]);
    var c = r && r.content && r.content['application/json'];
    return c ? { code: codes[0], body: sample(spec, c.schema, 0) } : null;
  }

  function examplePath(path, op) {
    var p = path;
    (op.parameters || []).forEach(function (prm) {
      if (prm.in === 'path') p = p.replace('{' + prm.name + '}', '3f2b8c1e-5a4d-4e7b-9c0a-1d2e3f4a5b6c');
    });
    return p;
  }

  function codeSamples(spec, method, path, op, base) {
    var url = base + examplePath(path, op);
    var body = requestExample(spec, op);
    var json = body != null ? JSON.stringify(body, null, 2) : null;
    var M = method.toUpperCase();
    var curl = 'curl -X ' + M + ' "' + url + '" \\\n  -H "Authorization: Bearer $PREDICTABLE_API_KEY"' +
      (json ? ' \\\n  -H "Content-Type: application/json" \\\n  -d \'' + JSON.stringify(body) + '\'' : '');
    var js = 'const res = await fetch("' + url + '", {\n  method: "' + M + '",\n  headers: {\n    Authorization: `Bearer ${process.env.PREDICTABLE_API_KEY}`,' +
      (json ? '\n    "Content-Type": "application/json",' : '') + '\n  },' +
      (json ? '\n  body: JSON.stringify(' + json.replace(/\n/g, '\n  ') + '),' : '') + '\n});\nconst data = await res.json();';
    var py = 'import os, requests\n\nres = requests.' + method.toLowerCase() + '(\n    "' + url + '",\n    headers={"Authorization": f"Bearer {os.environ[\'PREDICTABLE_API_KEY\']}"},' +
      (json ? '\n    json=' + pyLiteral(body, 4) + ',' : '') + '\n)\ndata = res.json()';
    return [['cURL', curl], ['JavaScript', js], ['Python', py]];
  }

  function pyLiteral(v, indent) {
    return JSON.stringify(v, null, 4).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')
      .replace(/\n/g, '\n' + new Array(indent + 1).join(' '));
  }

  function codeTabs(id, samples) {
    return '<div class="dd-code" data-dd-tabs="' + esc(id) + '"><div class="dd-code-head">' +
      samples.map(function (s, i) { return '<button type="button" class="dd-ctab' + (i ? '' : ' on') + '" data-dd-ctab="' + i + '">' + esc(s[0]) + '</button>'; }).join('') +
      '<button type="button" class="dd-copy" data-dd-copy>Copiar</button></div>' +
      samples.map(function (s, i) { return '<pre class="dd-pre"' + (i ? ' hidden' : '') + ' data-dd-cpane="' + i + '"><code>' + esc(s[1]) + '</code></pre>'; }).join('') +
      '</div>';
  }

  function schemaType(spec, s) {
    s = resolve(spec, s);
    var t = Array.isArray(s.type) ? s.type.filter(function (x) { return x !== 'null'; }).join(' | ') : (s.type || (s.properties ? 'object' : ''));
    if (t === 'array' && s.items) t = schemaType(spec, s.items) + '[]';
    if (s.enum) t += ' (' + s.enum.filter(function (v) { return v !== null; }).join(', ') + ')';
    return t || 'any';
  }

  function paramsTable(spec, op) {
    var rows = (op.parameters || []).map(function (p) {
      return '<tr><td><code>' + esc(p.name) + '</code>' + (p.required ? ' <span class="dd-req">obligatorio</span>' : '') + '</td><td>' + esc(p.in === 'path' ? 'ruta' : 'query') + '</td><td>' + esc(schemaType(spec, p.schema)) + '</td><td>' + esc(p.description || '') + '</td></tr>';
    });
    var c = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
    if (c) {
      var s = resolve(spec, c.schema);
      var props = {};
      var req = s.required || [];
      (s.allOf || [s]).forEach(function (part) { part = resolve(spec, part); Object.assign(props, part.properties || {}); req = req.concat(part.required || []); });
      Object.keys(props).forEach(function (k) {
        var ps = resolve(spec, props[k]);
        rows.push('<tr><td><code>' + esc(k) + '</code>' + (req.indexOf(k) !== -1 ? ' <span class="dd-req">obligatorio</span>' : '') + '</td><td>body</td><td>' + esc(schemaType(spec, ps)) + '</td><td>' + esc(ps.description || '') + '</td></tr>');
      });
    }
    if (!rows.length) return '';
    return '<div class="dd-tablewrap"><table class="dd-table"><thead><tr><th>Parámetro</th><th>Dónde</th><th>Tipo</th><th>Descripción</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }

  // ─── Guías ────────────────────────────────────────────────────────────────
  function guides(spec, o) {
    var events = ((spec.components.schemas.Event || {}).properties || {}).type;
    var evList = events && events.enum ? events.enum : [];
    var verifyNode = [
      "import crypto from 'node:crypto';",
      '',
      '// En tu endpoint: usa el body CRUDO (sin parsear) y el secreto del webhook.',
      'function verify(rawBody, header, secret) {',
      "  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));",
      '  const expected = crypto.createHmac(\'sha256\', secret).update(`${parts.t}.${rawBody}`).digest(\'hex\');',
      '  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300; // 5 minutos',
      "  return fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ''));",
      '}',
    ].join('\n');
    var verifyPy = [
      'import hmac, hashlib, time',
      '',
      'def verify(raw_body: bytes, header: str, secret: str) -> bool:',
      "    parts = dict(p.split('=', 1) for p in header.split(','))",
      "    signed = f\"{parts['t']}.\".encode() + raw_body",
      '    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()',
      "    fresh = abs(time.time() - int(parts['t'])) < 300",
      "    return fresh and hmac.compare_digest(expected, parts.get('v1', ''))",
    ].join('\n');
    var payload = JSON.stringify({ id: '8c1e…', type: 'message.received', created_at: '2026-09-23T15:04:05Z', api_version: spec.info.version, data: { message: { id: '…', contact_id: '…', channel: 'whatsapp', direction: 'in', body: 'Hola, sí me interesa. ¿Hablamos el jueves?', status: 'delivered', sent_at: '2026-09-23T15:04:02Z' } } }, null, 2);
    var claudeCode = 'claude mcp add --transport http predictable ' + o.mcpUrl + ' \\\n  --header "Authorization: Bearer $PREDICTABLE_API_KEY"';

    return [
      section('empezar', 'Empezar', md(spec.info.description.split('\n\n')[0]) +
        '<ol class="dd-steps"><li>En Predictable, entra a <strong>Desarrolladores → Claves de API</strong> y crea una clave. Se muestra una sola vez: guárdala en un gestor de secretos, nunca en el código ni en el navegador.</li>' +
        '<li>Prueba la conexión con <code>GET /v1/me</code>.</li>' +
        '<li>Carga tus contactos con <code>POST /v1/contacts/bulk</code> usando <code>external_id</code> = el id de tu CRM, para que reenviar el mismo registro lo actualice en vez de duplicarlo.</li>' +
        '<li>Registra un webhook para enterarte al instante de respuestas, cambios de estado, señales y reuniones.</li></ol>' +
        '<div class="dd-kv"><div><span>URL base</span><code>' + esc(o.apiBase) + '</code></div><div><span>Especificación OpenAPI</span><a href="openapi.json" target="_blank" rel="noopener">openapi.json</a> (impórtala en Postman, Insomnia o Zapier)</div></div>' +
        codeTabs('me', codeSamples(spec, 'get', '/v1/me', { parameters: [] }, o.apiBase))),
      section('auth', 'Autenticación', md('Cada request lleva la clave en la cabecera `Authorization: Bearer <clave>` (también se acepta `X-API-Key`). Las claves empiezan con `pai_live_`.\n\n**Permisos:** una clave de **solo lectura** puede consultar todo; una de **lectura y escritura** además crea, actualiza, enrola y borra. Usa la de menor permiso que tu integración necesite. Una clave revocada deja de funcionar al instante.\n\nLa API responde siempre con los datos de la cuenta dueña de la clave: nunca ves ni tocas datos de otra cuenta.')),
      section('limites', 'Paginación y límites', md('Las listas devuelven `{ data, has_more, next_cursor }`. Para la página siguiente, repite la llamada con `?cursor=<next_cursor>`. `limit` va de 1 a 200 (50 por defecto).\n\n**Sincronización incremental:** guarda la fecha de tu última sincronización y pide `GET /v1/contacts?updated_after=<fecha>`.\n\n**Límite de ritmo:** 120 requests por minuto por clave. Las cabeceras `X-RateLimit-Limit` y `X-RateLimit-Remaining` te dicen cuánto te queda; al pasarte recibes `429 rate_limited`: espera unos segundos y reintenta.\n\n**Lotes:** hasta 500 contactos por `POST /v1/contacts/bulk` y por enrolamiento; hasta 100 contactos por enriquecimiento.')),
      section('errores', 'Errores', md('Los errores devuelven el código HTTP correspondiente y `{ "error": { "code", "message", "request_id" } }`. El `message` está escrito para personas; decide con el `code`.') +
        '<div class="dd-tablewrap"><table class="dd-table"><thead><tr><th>HTTP</th><th>code</th><th>Qué significa</th></tr></thead><tbody>' +
        [['400', 'invalid_request / invalid_json', 'Falta un parámetro o no tiene el formato correcto.'], ['401', 'missing_api_key / invalid_api_key / revoked_api_key', 'La clave falta, no existe o fue revocada.'], ['403', 'insufficient_scope', 'La clave es de solo lectura.'], ['404', 'not_found / route_not_found', 'El recurso no existe o no es de tu cuenta.'], ['409', 'conflict / campaign_completed / invalid_state', 'La operación choca con el estado actual.'], ['429', 'rate_limited', 'Más de 120 requests por minuto.'], ['500', 'internal_error', 'Error nuestro: reintenta y, si se repite, escríbenos con el request_id.']]
          .map(function (r) { return '<tr><td>' + r[0] + '</td><td><code>' + esc(r[1]) + '</code></td><td>' + esc(r[2]) + '</td></tr>'; }).join('') +
        '</tbody></table></div>'),
      section('webhooks', 'Webhooks', md('Registra una URL **https** (en Desarrolladores → Webhooks o con `POST /v1/webhooks`) y Predictable le enviará un `POST` con cada evento que elijas. Responde con un código **2xx en menos de 10 segundos**; si no, reintentamos con espera creciente (1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h). Tras 50 fallos seguidos el webhook se desactiva y lo ves en la app.\n\nCada envío lleva las cabeceras `Predictable-Event`, `Predictable-Delivery` (úsala para no procesar dos veces la misma entrega) y `Predictable-Signature: t=<unix>,v1=<firma>`, donde la firma es `HMAC-SHA256(secreto, "<t>.<body>")` en hexadecimal. **Verifica siempre la firma** antes de confiar en el contenido.') +
        '<div class="dd-tablewrap"><table class="dd-table"><thead><tr><th>Evento</th><th>Cuándo ocurre</th></tr></thead><tbody>' +
        evList.map(function (e) { return '<tr><td><code>' + esc(e) + '</code></td><td>' + esc(EVENT_HELP[e] || '') + '</td></tr>'; }).join('') +
        '</tbody></table></div><h4 class="dd-h4">Ejemplo de envío</h4><pre class="dd-pre"><code>' + esc(payload) + '</code></pre>' +
        '<h4 class="dd-h4">Verificar la firma</h4>' + codeTabs('verify', [['Node.js', verifyNode], ['Python', verifyPy]]) +
        md('Si tu sistema no puede recibir webhooks, consulta `GET /v1/events?created_after=<fecha>` cada pocos minutos: es la misma información (se guarda 30 días).')),
      section('mcp', 'MCP (agentes de IA)', md('Predictable también es un servidor **MCP** (Model Context Protocol): conecta Claude, ChatGPT, Cursor o tu propio agente y podrá consultar y operar tu cuenta con las mismas herramientas y permisos que la API REST (una herramienta por operación: `contacts_list`, `contacts_bulk_upsert`, `campaigns_enroll`, `messages_list`…).\n\nTransporte: Streamable HTTP. Autenticación: la misma clave, en `Authorization: Bearer <clave>`.') +
        '<div class="dd-kv"><div><span>URL del servidor MCP</span><code>' + esc(o.mcpUrl) + '</code></div></div>' +
        codeTabs('mcp', [
          ['Claude Code', claudeCode],
          ['Cursor / JSON', JSON.stringify({ mcpServers: { predictable: { url: o.mcpUrl, headers: { Authorization: 'Bearer ${env:PREDICTABLE_API_KEY}' } } } }, null, 2)],
          ['Solo URL', o.mcpUrl + '?key=<tu clave>\n\n# Para clientes que solo aceptan una URL (conectores personalizados).\n# La clave queda en la URL: usa una de solo lectura si puedes y revócala si se comparte.'],
        ])),
    ].join('');
  }

  var EVENT_HELP = {
    'contact.created': 'Se agregó un contacto a una lista (desde Buscar, el Radar, la Bandeja, a mano o por la API).',
    'contact.status_changed': 'Cambió el estado del contacto en el CRM (p. ej. respondio → reunion_agendada).',
    'contact.enriched': 'Terminó el enriquecimiento del contacto (email y/o teléfono).',
    'message.received': 'Un lead respondió por WhatsApp, email o LinkedIn.',
    'message.sent': 'Salió un mensaje (de una campaña o respondido desde la Bandeja).',
    'signal.created': 'El Radar te entregó una señal de compra nueva (las del lote diario; la reserva no se envía).',
    'enrollment.status_changed': 'Un lead de una campaña respondió, se dio de baja, terminó la cadencia, se pausó o falló.',
    'meeting.completed': 'El Meeting Coach terminó el reporte de una reunión.',
  };

  function section(id, title, body) {
    return '<section class="dd-sec" id="dd-' + id + '"><h2 class="dd-h2">' + esc(title) + '</h2>' + body + '</section>';
  }

  function endpoints(spec, o) {
    var byTag = {};
    Object.keys(spec.paths).forEach(function (path) {
      Object.keys(spec.paths[path]).forEach(function (method) {
        var op = spec.paths[path][method];
        var tag = (op.tags && op.tags[0]) || 'Otros';
        (byTag[tag] = byTag[tag] || []).push({ path: path, method: method, op: op });
      });
    });
    return (spec.tags || []).map(function (t) {
      var list = byTag[t.name] || [];
      return '<section class="dd-sec" id="dd-tag-' + slug(t.name) + '"><h2 class="dd-h2">' + esc(t.name) + '</h2>' + md(t.description || '') +
        list.map(function (e) {
          var ex = responseExample(spec, e.op);
          return '<article class="dd-ep" id="dd-op-' + esc(e.op.operationId) + '">' +
            '<div class="dd-ep-head"><span class="dd-m dd-m-' + e.method + '">' + e.method.toUpperCase() + '</span><code class="dd-path">' + esc(e.path) + '</code></div>' +
            '<div class="dd-ep-title">' + esc(e.op.summary) + (e.op.tags && isWrite(e.method) ? ' <span class="dd-scope">requiere escritura</span>' : '') + '</div>' +
            (e.op.description ? md(e.op.description) : '') +
            paramsTable(spec, e.op) +
            codeTabs(e.op.operationId, codeSamples(spec, e.method, e.path, e.op, o.apiBase)) +
            (ex ? '<details class="dd-resp"><summary>Respuesta ' + esc(ex.code) + '</summary><pre class="dd-pre"><code>' + esc(JSON.stringify(ex.body, null, 2)) + '</code></pre></details>' : '') +
            '</article>';
        }).join('') + '</section>';
    }).join('');
  }

  function isWrite(m) { return m !== 'get'; }
  function slug(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-'); }

  function nav(spec) {
    var g = [['empezar', 'Empezar'], ['auth', 'Autenticación'], ['limites', 'Paginación y límites'], ['errores', 'Errores'], ['webhooks', 'Webhooks'], ['mcp', 'MCP (agentes de IA)']];
    var html = '<div class="dd-nav-lbl">Guías</div>' + g.map(function (x) { return '<a href="#dd-' + x[0] + '" data-dd-go="dd-' + x[0] + '">' + esc(x[1]) + '</a>'; }).join('');
    html += '<div class="dd-nav-lbl">Referencia</div>';
    (spec.tags || []).forEach(function (t) { html += '<a href="#dd-tag-' + slug(t.name) + '" data-dd-go="dd-tag-' + slug(t.name) + '">' + esc(t.name) + '</a>'; });
    return html;
  }

  function render(container, spec, opts) {
    if (!container) return;
    injectCss();
    var o = {
      apiBase: (opts && opts.apiBase) || (spec.servers && spec.servers[0] && spec.servers[0].url) || '',
      mcpUrl: (opts && opts.mcpUrl) || '',
    };
    if (!o.mcpUrl && o.apiBase) o.mcpUrl = o.apiBase.replace(/\/public-api$/, '/mcp');
    container.innerHTML = '<div class="dd-wrap"><nav class="dd-nav" aria-label="Documentación">' + nav(spec) + '</nav>' +
      '<div class="dd-main">' + guides(spec, o) + endpoints(spec, o) + '</div></div>';
    if (!container.getAttribute('data-dd-bound')) {
      container.setAttribute('data-dd-bound', '1');
      container.addEventListener('click', onClick);
    }
  }

  function onClick(e) {
    var t = e.target;
    var go = t.closest && t.closest('[data-dd-go]');
    if (go) {
      var el = document.getElementById(go.getAttribute('data-dd-go'));
      if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }
    var tab = t.closest && t.closest('[data-dd-ctab]');
    if (tab) {
      var box = tab.closest('.dd-code');
      var i = tab.getAttribute('data-dd-ctab');
      box.querySelectorAll('[data-dd-ctab]').forEach(function (b) { b.classList.toggle('on', b === tab); });
      box.querySelectorAll('[data-dd-cpane]').forEach(function (p) { p.hidden = p.getAttribute('data-dd-cpane') !== i; });
      return;
    }
    var copy = t.closest && t.closest('[data-dd-copy]');
    if (copy) {
      var pane = copy.closest('.dd-code').querySelector('[data-dd-cpane]:not([hidden])');
      copyText(pane ? pane.textContent : '', copy);
    }
  }

  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var prev = btn.textContent;
      btn.textContent = 'Copiado';
      setTimeout(function () { btn.textContent = prev; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* noop */ }
    document.body.removeChild(ta);
  }

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = [
      '.dd-wrap{display:grid;grid-template-columns:200px minmax(0,1fr);gap:28px;align-items:start}',
      '.dd-nav{position:sticky;top:12px;display:flex;flex-direction:column;gap:2px;font-size:12.5px;max-height:calc(100vh - 40px);overflow:auto}',
      '.dd-nav a{color:var(--ink-3);text-decoration:none;padding:5px 10px;border-radius:var(--r-sm,6px)}',
      '.dd-nav a:hover{color:var(--ink);background:var(--surface2)}',
      '.dd-nav-lbl{font-size:10.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--ink-4);margin:12px 10px 4px}',
      '.dd-nav-lbl:first-child{margin-top:0}',
      '.dd-main{min-width:0;display:flex;flex-direction:column;gap:28px}',
      '.dd-sec{scroll-margin-top:16px}',
      '.dd-h2{font-size:19px;font-weight:700;color:var(--ink);margin:0 0 8px}',
      '.dd-h4{font-size:13px;font-weight:700;color:var(--ink);margin:16px 0 6px}',
      '.dd-sec p{font-size:13px;line-height:1.65;color:var(--ink-2);margin:6px 0}',
      '.dd-sec code,.dd-table code,.dd-kv code{font-family:var(--font-mono,monospace);font-size:12px;background:var(--surface2);border:1px solid var(--hair);border-radius:4px;padding:1px 5px;overflow-wrap:anywhere}',
      '.dd-sec .dd-pre code{background:none;border:0;border-radius:0;padding:0;font-size:inherit;overflow-wrap:normal}',
      '.dd-steps{font-size:13px;line-height:1.65;color:var(--ink-2);padding-left:20px;margin:10px 0}',
      '.dd-steps li{margin:4px 0}',
      '.dd-kv{display:flex;flex-direction:column;gap:8px;margin:12px 0;font-size:12.5px;color:var(--ink-2)}',
      '.dd-kv>div{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
      '.dd-kv span{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4);min-width:170px}',
      '.dd-kv a{color:var(--accent)}',
      '.dd-ep{border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:16px 18px;margin-top:14px;background:var(--surface);scroll-margin-top:16px}',
      '.dd-ep-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dd-m{font-family:var(--font-mono,monospace);font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;letter-spacing:.4px}',
      '.dd-m-get{background:var(--green-soft);color:var(--green)}',
      '.dd-m-post{background:var(--accent-soft);color:var(--accent)}',
      '.dd-m-patch{background:var(--amber-soft);color:var(--amber)}',
      '.dd-m-delete{background:var(--red-soft);color:var(--red)}',
      '.dd-path{font-family:var(--font-mono,monospace);font-size:13px;color:var(--ink);word-break:break-all}',
      '.dd-ep-title{font-size:14px;font-weight:700;color:var(--ink);margin-top:8px}',
      '.dd-scope{font-size:10.5px;font-weight:600;color:var(--amber);background:var(--amber-soft);padding:2px 8px;border-radius:999px;margin-left:6px;vertical-align:middle}',
      '.dd-req{font-size:10px;font-weight:600;color:var(--red)}',
      '.dd-tablewrap{overflow-x:auto;margin:10px 0}',
      '.dd-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.dd-table th{text-align:left;font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4);font-weight:700;padding:6px 8px;border-bottom:1px solid var(--hair)}',
      '.dd-table td{padding:7px 8px;border-bottom:1px solid var(--hair-2,var(--hair));color:var(--ink-2);vertical-align:top}',
      '.dd-code{border:1px solid var(--hair);border-radius:var(--r-md,10px);overflow:hidden;margin:10px 0;background:var(--surface2)}',
      '.dd-code-head{display:flex;gap:4px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--hair)}',
      '.dd-ctab,.dd-copy{font:inherit;font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--ink-3);cursor:pointer}',
      '.dd-ctab.on{background:var(--surface);border-color:var(--hair);color:var(--ink)}',
      '.dd-copy{margin-left:auto;border-color:var(--hair)}',
      '.dd-copy:hover,.dd-ctab:hover{color:var(--ink)}',
      '.dd-ctab:focus-visible,.dd-copy:focus-visible,.dd-nav a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
      '.dd-pre{margin:0;padding:12px 14px;overflow-x:auto;font-family:var(--font-mono,monospace);font-size:11.8px;line-height:1.6;color:var(--ink-2);white-space:pre;background:var(--surface2)}',
      '.dd-sec>.dd-pre{border:1px solid var(--hair);border-radius:var(--r-md,10px)}',
      '.dd-resp{margin-top:8px;font-size:12.5px;color:var(--ink-3)}',
      '.dd-resp summary{cursor:pointer;font-weight:600}',
      '.dd-resp .dd-pre{border:1px solid var(--hair);border-radius:var(--r-md,10px);margin-top:6px}',
      '@media (max-width:900px){.dd-wrap{grid-template-columns:1fr}.dd-nav{position:static;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;max-height:none;padding-bottom:4px}.dd-nav a{white-space:nowrap}.dd-nav-lbl{display:none}.dd-kv span{min-width:0}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  global.DevDocs = { load: load, render: render, copyText: copyText, EVENT_HELP: EVENT_HELP };
})(window);
