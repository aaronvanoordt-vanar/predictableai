/**
 * js/campaign-flow.js — la cadencia de una campaña como grafo (`campaigns.flow`).
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ ESPEJO EXACTO de supabase/functions/_shared/campaign-flow.ts. Cualquier
 *   cambio de esquema, validación o recorrido se hace en los dos archivos en
 *   el mismo PR (mismo criterio que apollo-enums.js ↔ icp-taxonomy.ts).
 *
 * Forma (v1):
 *   { v: 1, nodes: Node[] }
 *   Action    = { id, type: 'action', channel, delay, content, settings? }
 *   Condition = { id, type: 'condition', check, delay, yes: Action[], no: Action[] }  (delay siempre after_prev)
 *   delay     = { mode: 'after_prev' | 'with_prev', days, hours }
 *   content   = { kind: template_a|template_b|template_c|ai|custom, angle?, instructions?, subject?, body? }
 *
 * Public API (global `CampaignFlow`): constantes, newId, emptyFlow, normalize,
 * validate, actions, ordinal, find, firstNode, nextAfter, enterBranch, delayMs,
 * legacyKind, fromLegacySteps, estimateCredits, labels para la UI.
 */
(function (global) {
  'use strict';

  var FLOW_VERSION = 1;
  var CHANNELS = ['whatsapp', 'email', 'linkedin_connect', 'linkedin_message'];
  var CONTENT_KINDS = ['template_a', 'template_b', 'template_c', 'ai', 'custom'];
  var ANGLES = ['apertura', 'valor', 'prueba_social', 'objecion', 'ultima_carta', 'libre'];
  var CONDITIONS = ['linkedin_connected', 'whatsapp_read', 'email_opened', 'has_phone', 'has_email', 'has_linkedin'];
  var DELAY_MODES = ['after_prev', 'with_prev'];
  var AI_MESSAGE_CREDITS = 3;
  var SEND_CREDITS = 1;

  // Copy para la UI (solo en el espejo JS).
  var CHANNEL_META = {
    whatsapp:         { label: 'WhatsApp',            short: 'WA',       tone: 'green',  needs: 'wati' },
    email:            { label: 'Email',               short: 'Email',    tone: 'blue',   needs: 'apollo' },
    linkedin_connect: { label: 'LinkedIn',            short: 'LinkedIn', tone: 'teal',   needs: 'dripify' },
    linkedin_message: { label: 'LinkedIn · mensaje (sin proveedor)', short: 'LI', tone: 'gray', needs: null, hidden: true },
  };
  var KIND_LABELS = {
    template_a: 'Saludo 1 (plantilla de WhatsApp)',
    template_b: 'Recordatorio (plantilla de WhatsApp)',
    template_c: 'Último intento (plantilla de WhatsApp)',
    ai: 'IA personalizada',
    custom: 'Mi texto',
  };
  var ANGLE_LABELS = {
    apertura: 'Apertura (primer contacto)',
    valor: 'Seguimiento de valor',
    prueba_social: 'Prueba social',
    objecion: 'Objeción preventiva',
    ultima_carta: 'Última carta',
    libre: 'Libre (según tus instrucciones)',
  };
  var CONDITION_LABELS = {
    linkedin_connected: { label: 'Aceptó la conexión de LinkedIn', hint: 'Lo reporta tu cuenta de LinkedIn. Necesita un paso de LinkedIn antes.', needs: 'dripify' },
    whatsapp_read: { label: 'Leyó el WhatsApp', hint: 'Doble check azul del WhatsApp.', needs: 'wati' },
    email_opened: { label: 'Abrió el email', hint: 'Apertura registrada por el proveedor de email.', needs: 'apollo' },
    has_phone: { label: 'Tiene teléfono', hint: 'El lead tiene un número revelado.', needs: null },
    has_email: { label: 'Tiene email', hint: 'El lead tiene un email revelado.', needs: null },
    has_linkedin: { label: 'Tiene LinkedIn', hint: 'El lead tiene URL de perfil.', needs: null },
  };

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function clampInt(v, min, max) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function newId() {
    var s = '';
    while (s.length < 8) s += Math.random().toString(36).slice(2);
    return 'n' + s.slice(0, 8);
  }

  function emptyFlow() { return { v: FLOW_VERSION, nodes: [] }; }

  function normalizeDelay(raw, allowWithPrev) {
    if (allowWithPrev === undefined) allowWithPrev = true;
    var d = isObj(raw) ? raw : {};
    var mode = allowWithPrev && d.mode === 'with_prev' ? 'with_prev' : 'after_prev';
    return { mode: mode, days: mode === 'with_prev' ? 0 : clampInt(d.days, 0, 365), hours: mode === 'with_prev' ? 0 : clampInt(d.hours, 0, 23) };
  }

  function normalizeContent(raw, channel) {
    var c = isObj(raw) ? raw : {};
    var kind = String(c.kind == null ? '' : c.kind);
    if (kind === 'ai_personalized') kind = 'ai';
    if (CONTENT_KINDS.indexOf(kind) === -1) kind = channel === 'whatsapp' ? 'template_a' : 'ai';
    var out = { kind: kind };
    if (kind === 'ai') {
      var angle = String(c.angle == null ? '' : c.angle);
      out.angle = ANGLES.indexOf(angle) !== -1 ? angle : 'apertura';
      if (typeof c.instructions === 'string' && c.instructions.trim()) out.instructions = c.instructions.trim().slice(0, 600);
    }
    if (kind === 'custom') {
      if (typeof c.subject === 'string') out.subject = c.subject.trim().slice(0, 200);
      if (typeof c.body === 'string') out.body = c.body.trim().slice(0, 4000);
    }
    return out;
  }

  function normalizeAction(raw, allowWithPrev) {
    var channel = raw && CHANNELS.indexOf(raw.channel) !== -1 ? raw.channel : 'email';
    var node = {
      id: raw && typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 40) : newId(),
      type: 'action',
      channel: channel,
      delay: normalizeDelay(raw && raw.delay, allowWithPrev),
      content: normalizeContent(raw && raw.content, channel),
    };
    if (raw && isObj(raw.settings) && Object.keys(raw.settings).length) node.settings = raw.settings;
    return node;
  }

  function normalizeList(raw, allowConditions) {
    var list = Array.isArray(raw) ? raw : [];
    var out = [];
    list.forEach(function (n) {
      if (!isObj(n)) return;
      if (n.type === 'condition') {
        if (!allowConditions) return; // condiciones anidadas: se descartan
        var check = CONDITIONS.indexOf(n.check) !== -1 ? n.check : 'linkedin_connected';
        out.push({
          id: typeof n.id === 'string' && n.id.trim() ? n.id.trim().slice(0, 40) : newId(),
          type: 'condition',
          check: check,
          delay: normalizeDelay(n.delay, false),
          yes: normalizeList(n.yes, false),
          no: normalizeList(n.no, false),
        });
        return;
      }
      // with_prev se conserva tal cual: validate() avisa si no tiene una acción
      // antes y el motor lo trata como espera 0.
      out.push(normalizeAction(n, true));
    });
    return out;
  }

  function normalize(raw) {
    var f = isObj(raw) ? raw : {};
    return { v: FLOW_VERSION, nodes: normalizeList(f.nodes, true) };
  }

  function validate(raw) {
    var errors = [];
    var f = normalize(raw);
    var ids = {};
    function seen(id) {
      if (ids[id]) errors.push({ nodeId: id, message: 'Hay dos pasos con el mismo id.' });
      ids[id] = true;
    }
    function checkAction(a, list, idx, label) {
      seen(a.id);
      if (a.delay.mode === 'with_prev' && !(idx > 0 && list[idx - 1].type === 'action')) {
        errors.push({ nodeId: a.id, message: label + ': "junto con el anterior" necesita otro envío justo antes.' });
      }
      if (a.channel === 'linkedin_connect' && !(a.settings && a.settings.dripify_campaign_id)) {
        errors.push({ nodeId: a.id, message: label + ': el paso de LinkedIn necesita una campaña de Dripify.' });
      }
      if (a.content.kind.indexOf('template_') === 0 && a.channel !== 'whatsapp') {
        errors.push({ nodeId: a.id, message: label + ': las plantillas de saludo son solo de WhatsApp.' });
      }
      if (a.content.kind === 'custom') {
        if (!a.content.body) errors.push({ nodeId: a.id, message: label + ': el texto propio está vacío.' });
        if (a.channel === 'email' && !a.content.subject) errors.push({ nodeId: a.id, message: label + ': el email necesita asunto.' });
      }
    }
    var count = 0;
    f.nodes.forEach(function (n, i) {
      if (n.type === 'condition') {
        seen(n.id);
        if (!n.yes.length && !n.no.length) errors.push({ nodeId: n.id, message: 'La condición no tiene pasos en ninguna rama.' });
        n.yes.forEach(function (a, j) { count++; checkAction(a, n.yes, j, 'Rama Sí, paso ' + (j + 1)); });
        n.no.forEach(function (a, j) { count++; checkAction(a, n.no, j, 'Rama No, paso ' + (j + 1)); });
        return;
      }
      count++;
      checkAction(n, f.nodes, i, 'Paso ' + (i + 1));
    });
    if (!count) errors.push({ nodeId: null, message: 'Agrega al menos un paso a la cadencia.' });
    return { ok: !errors.length, errors: errors };
  }

  function actions(flow) {
    var out = [];
    (flow && flow.nodes || []).forEach(function (n) {
      if (n.type === 'action') out.push(n);
      else { out.push.apply(out, n.yes); out.push.apply(out, n.no); }
    });
    return out;
  }

  function ordinal(flow, nodeId) {
    var list = actions(flow);
    for (var i = 0; i < list.length; i++) if (list[i].id === nodeId) return i;
    return -1;
  }

  function find(flow, nodeId) {
    if (!nodeId || !flow) return null;
    for (var i = 0; i < flow.nodes.length; i++) {
      var n = flow.nodes[i];
      if (n.id === nodeId) return { node: n, list: flow.nodes, index: i, parent: null, branch: null };
      if (n.type === 'condition') {
        var branches = ['yes', 'no'];
        for (var b = 0; b < 2; b++) {
          var br = branches[b];
          for (var j = 0; j < n[br].length; j++) {
            if (n[br][j].id === nodeId) return { node: n[br][j], list: n[br], index: j, parent: n, branch: br };
          }
        }
      }
    }
    return null;
  }

  function firstNode(flow) { return (flow && flow.nodes && flow.nodes[0]) || null; }

  function nextAfter(flow, nodeId) {
    var loc = find(flow, nodeId);
    if (!loc) return null;
    if (loc.index + 1 < loc.list.length) return loc.list[loc.index + 1];
    if (loc.parent) return nextAfter(flow, loc.parent.id);
    return null;
  }

  function enterBranch(flow, conditionId, branch) {
    var loc = find(flow, conditionId);
    if (!loc || loc.node.type !== 'condition') return null;
    return loc.node[branch][0] || nextAfter(flow, conditionId);
  }

  function delayMs(node) {
    if (!node) return 0;
    return (node.delay.days * 24 + node.delay.hours) * 60 * 60 * 1000;
  }

  function legacyKind(node) { return node.content.kind === 'ai' ? 'ai_personalized' : node.content.kind; }

  function fromLegacySteps(rows) {
    var steps = (Array.isArray(rows) ? rows : []).slice().sort(function (a, b) {
      return (Number(a.position || 0) - Number(b.position || 0)) || (Number(a.offset_hours || 0) - Number(b.offset_hours || 0));
    });
    var flow = emptyFlow();
    var prevOffset = 0;
    var aiSeen = {};
    var openCond = null;
    steps.forEach(function (s, i) {
      var offset = Math.max(0, Number(s.offset_hours || 0));
      var channel = CHANNELS.indexOf(s.channel) !== -1 ? s.channel : 'email';
      var kindRaw = String(s.content_kind == null ? '' : s.content_kind);
      var kind = kindRaw === 'ai_personalized' ? 'ai' : (CONTENT_KINDS.indexOf(kindRaw) !== -1 ? kindRaw : 'ai');
      var content = { kind: kind };
      if (kind === 'ai') {
        var chKey = channel.indexOf('linkedin') === 0 ? 'linkedin' : channel;
        content.angle = aiSeen[chKey] ? 'valor' : 'apertura';
        aiSeen[chKey] = true;
      }
      if (kind === 'custom') { content.subject = String(s.subject == null ? '' : s.subject).trim(); content.body = String(s.body == null ? '' : s.body).trim(); }
      var cond = s.condition === 'if_connected';
      var startsBranch = cond && !openCond;
      var withPrev = i > 0 && offset === prevOffset && !startsBranch && !(openCond && !cond);
      var delta = Math.max(0, offset - prevOffset);
      var node = {
        id: typeof s.node_id === 'string' && s.node_id.trim() ? s.node_id.trim() : newId(),
        type: 'action',
        channel: channel,
        delay: withPrev ? { mode: 'with_prev', days: 0, hours: 0 } : { mode: 'after_prev', days: Math.floor(delta / 24), hours: delta % 24 },
        content: content,
      };
      if (isObj(s.settings) && Object.keys(s.settings).length) node.settings = Object.assign({}, s.settings);
      if (cond) {
        if (!openCond) {
          openCond = { id: typeof s.condition_node_id === 'string' && s.condition_node_id ? s.condition_node_id : newId(), type: 'condition', check: 'linkedin_connected', delay: { mode: 'after_prev', days: 0, hours: 0 }, yes: [], no: [] };
          flow.nodes.push(openCond);
        }
        openCond.yes.push(node);
      } else {
        openCond = null;
        flow.nodes.push(node);
      }
      prevOffset = offset;
    });
    return flow;
  }

  function estimateCredits(flow, leads) {
    var n = Math.max(0, Number(leads) || 0);
    var ai = 0, sends = 0;
    actions(flow).forEach(function (a) {
      if (a.channel === 'linkedin_message') return;
      sends++;
      if (a.content.kind === 'ai' && a.channel !== 'linkedin_connect') ai++;
    });
    return { aiMessages: ai * n, sends: sends * n, credits: (ai * AI_MESSAGE_CREDITS + sends * SEND_CREDITS) * n };
  }

  /** Título corto de un nodo para tarjetas y tablas. */
  function nodeTitle(node) {
    if (!node) return '';
    if (node.type === 'condition') {
      var c = CONDITION_LABELS[node.check];
      return c ? '¿' + c.label + '?' : node.check;
    }
    var ch = CHANNEL_META[node.channel] || { label: node.channel };
    if (node.channel === 'linkedin_connect') {
      var dc = node.settings && node.settings.dripify_campaign_name;
      return ch.label + (dc ? ' · ' + dc : '');
    }
    var k = node.content.kind;
    if (k === 'ai') return ch.label + ' · IA: ' + (ANGLE_LABELS[node.content.angle] || node.content.angle || 'apertura').replace(/\s*\(.*\)$/, '');
    if (k === 'custom') return ch.label + ' · Mi texto';
    return ch.label + ' · ' + (KIND_LABELS[k] || k).replace(/\s*\(.*\)$/, '');
  }

  /** Copia profunda con ids nuevos (clonar una campaña). */
  function cloneWithNewIds(flow) {
    var f = normalize(flow);
    function act(a) { var c = JSON.parse(JSON.stringify(a)); c.id = newId(); return c; }
    return { v: FLOW_VERSION, nodes: f.nodes.map(function (n) {
      if (n.type === 'condition') return { id: newId(), type: 'condition', check: n.check, delay: n.delay, yes: n.yes.map(act), no: n.no.map(act) };
      return act(n);
    }) };
  }

  /** Duración aproximada en días: suma de esperas por el camino más largo. */
  function durationDays(flow) {
    var f = normalize(flow);
    var total = 0;
    function len(list) { var t = 0; list.forEach(function (a) { if (a.delay.mode === 'after_prev') t += a.delay.days + a.delay.hours / 24; }); return t; }
    f.nodes.forEach(function (n) {
      if (n.type === 'condition') { total += n.delay.days + n.delay.hours / 24 + Math.max(len(n.yes), len(n.no)); }
      else if (n.delay.mode === 'after_prev') total += n.delay.days + n.delay.hours / 24;
    });
    return Math.round(total * 10) / 10;
  }

  var A = function (channel, delay, content, extra) {
    var n = { id: newId(), type: 'action', channel: channel, delay: delay, content: content };
    if (extra) n.settings = extra;
    return n;
  };
  var D = function (days, hours) { return { mode: 'after_prev', days: days || 0, hours: hours || 0 }; };
  var W = { mode: 'with_prev', days: 0, hours: 0 };
  var C = function (check, delay, yes, no) { return { id: newId(), type: 'condition', check: check, delay: delay, yes: yes, no: no }; };

  /**
   * Cadencias fijas. Los pasos de LinkedIn salen sin campaña de LinkedIn
   * (Dripify): la validación pide elegirla. Cada llamada genera ids nuevos.
   */
  function templates() {
    return [
      {
        key: 'whatsapp_first', label: 'WhatsApp primero', needs: ['wati', 'apollo'],
        summary: 'Saludo por WhatsApp con el email de refuerzo el mismo día; si lo leyó, recordatorio; si no, un email de valor. Cierra con último intento y última carta.',
        build: function () { return { v: FLOW_VERSION, nodes: [
          A('whatsapp', D(0), { kind: 'template_a' }),
          A('email', W, { kind: 'ai', angle: 'apertura' }),
          C('whatsapp_read', D(2),
            [A('whatsapp', D(1), { kind: 'template_b' })],
            [A('email', D(1), { kind: 'ai', angle: 'valor' })]),
          A('whatsapp', D(3), { kind: 'template_c' }),
          A('email', D(3), { kind: 'ai', angle: 'ultima_carta' }),
        ] }; },
      },
      {
        key: 'email_first', label: 'Email primero', needs: ['apollo'],
        summary: 'Apertura por email; si lo abrió, seguimiento de valor; si no, WhatsApp. Luego prueba social, objeción preventiva y última carta.',
        build: function () { return { v: FLOW_VERSION, nodes: [
          A('email', D(0), { kind: 'ai', angle: 'apertura' }),
          C('email_opened', D(2),
            [A('email', D(1), { kind: 'ai', angle: 'valor' })],
            [A('whatsapp', D(1), { kind: 'template_a' })]),
          A('email', D(3), { kind: 'ai', angle: 'prueba_social' }),
          A('email', D(3), { kind: 'ai', angle: 'objecion' }),
          A('email', D(4), { kind: 'ai', angle: 'ultima_carta' }),
        ] }; },
      },
      {
        key: 'linkedin_first', label: 'LinkedIn primero', needs: ['dripify', 'apollo'],
        summary: 'Conexión por LinkedIn; a los 3 días, si aceptó, email de apertura; si no, WhatsApp y email en paralelo. Luego valor, recordatorio y última carta.',
        build: function () { return { v: FLOW_VERSION, nodes: [
          A('linkedin_connect', D(0), { kind: 'ai', angle: 'apertura' }, {}),
          C('linkedin_connected', D(3),
            [A('email', D(0), { kind: 'ai', angle: 'apertura' })],
            [A('whatsapp', D(0), { kind: 'template_a' }), A('email', W, { kind: 'ai', angle: 'apertura' })]),
          A('email', D(3), { kind: 'ai', angle: 'valor' }),
          A('whatsapp', D(3), { kind: 'template_b' }),
          A('email', D(4), { kind: 'ai', angle: 'ultima_carta' }),
        ] }; },
      },
    ];
  }

  /** "Día 0", "+2 días", "+6 h", "junto con el anterior" */
  function delayLabel(node, isFirst) {
    if (!node) return '';
    var d = node.delay;
    if (d.mode === 'with_prev') return 'junto con el anterior';
    var parts = [];
    if (d.days) parts.push(d.days + (d.days === 1 ? ' día' : ' días'));
    if (d.hours) parts.push(d.hours + ' h');
    if (!parts.length) return isFirst ? 'Al enrolar' : 'Enseguida';
    return (isFirst ? '' : '+') + parts.join(' ');
  }

  global.CampaignFlow = {
    FLOW_VERSION: FLOW_VERSION,
    CHANNELS: CHANNELS, CONTENT_KINDS: CONTENT_KINDS, ANGLES: ANGLES, CONDITIONS: CONDITIONS, DELAY_MODES: DELAY_MODES,
    AI_MESSAGE_CREDITS: AI_MESSAGE_CREDITS, SEND_CREDITS: SEND_CREDITS,
    ANGLE_LABELS: ANGLE_LABELS, CONDITION_LABELS: CONDITION_LABELS, CHANNEL_META: CHANNEL_META, KIND_LABELS: KIND_LABELS,
    nodeTitle: nodeTitle, cloneWithNewIds: cloneWithNewIds, durationDays: durationDays, templates: templates,
    newId: newId, emptyFlow: emptyFlow, normalize: normalize, validate: validate,
    actions: actions, ordinal: ordinal, find: find, firstNode: firstNode, nextAfter: nextAfter, enterBranch: enterBranch,
    delayMs: delayMs, legacyKind: legacyKind, fromLegacySteps: fromLegacySteps, estimateCredits: estimateCredits, delayLabel: delayLabel,
  };
})(typeof window !== 'undefined' ? window : globalThis);
