/**
 * js/phone-lines.js — ¿el número del lead está en WhatsApp? (2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ ESPEJO EXACTO de supabase/functions/_shared/phone-lines.ts (reglas y
 *   textos). El tipo de línea sale de js/phone-latam.js, espejo del
 *   normalizador del waterfall (_shared/phone-latam.ts): aquí no se repiten
 *   los planes de numeración. Se cambian juntos en el mismo PR: `deno test`
 *   (_shared/phone-lines.test.ts) evalúa los dos archivos y compara cada
 *   caso con el TS.
 *
 * Lo usan Listas (indicador por contacto) y el enrolamiento de Campañas
 * (cuántas plantillas no se mandan). Lo aprendido de los envíos vive en la
 * tabla `whatsapp_reachability` (solo la escribe el motor); `loadLearned`
 * la lee con la RLS del usuario y, si la tabla no existe aún, devuelve un
 * mapa vacío (el tipo de línea sigue funcionando).
 *
 * Public API (global `PhoneLines`): phoneDigits, reachKey, lineType,
 * apolloPhoneType, noWhatsappCode, whatsappReach, reachSummary, REACH_LABELS,
 * memberReach, loadLearned.
 */
(function (global) {
  'use strict';

  var COUNTRY_LABELS = {
    MX: 'México', AR: 'Argentina', BR: 'Brasil', CO: 'Colombia', CL: 'Chile', PE: 'Perú', EC: 'Ecuador',
    UY: 'Uruguay', PY: 'Paraguay', BO: 'Bolivia', VE: 'Venezuela', CR: 'Costa Rica', PA: 'Panamá',
    GT: 'Guatemala', SV: 'El Salvador', HN: 'Honduras', NI: 'Nicaragua', ES: 'España',
    US: 'EE. UU./Canadá', DO: 'República Dominicana', PR: 'Puerto Rico',
  };

  function phoneDigits(phone) {
    var d = String(phone == null ? '' : phone).replace(/\D/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    return d;
  }

  function reachKey(phone) {
    var d = phoneDigits(phone);
    if (/^521\d{10}$/.test(d) || /^549\d{10}$/.test(d)) return d.slice(0, 2) + d.slice(3);
    return d;
  }

  function lineType(phone, country, providerType) {
    var PL = global.PhoneLatam;
    var n = PL ? PL.normalizePhone(phone, { country: country, type: providerType }) : null;
    if (!n) return { country: null, kind: 'unknown', reason: 'El número no se pudo leer: se envía y se aprende del resultado.' };
    var iso = n.country;
    var de = iso && COUNTRY_LABELS[iso] ? ' de ' + COUNTRY_LABELS[iso] : '';
    switch (n.type) {
      case 'mobile':
        return { country: iso, kind: 'mobile', reason: 'Celular' + de + ' según su plan de numeración o el proveedor.' };
      case 'landline':
        return { country: iso, kind: 'landline', reason: 'Fijo' + de + ' según su plan de numeración o el proveedor.' };
      case 'switchboard':
        return { country: iso, kind: 'switchboard', reason: 'Conmutador o línea de la empresa' + de + ' (800, extensión o número central): no es el WhatsApp de la persona.' };
      default:
        if (iso === 'MX') return { country: iso, kind: 'unknown', reason: 'En México fijos y celulares comparten los 10 dígitos desde 2019: el número no dice cuál es.' };
        if (iso === 'AR') return { country: iso, kind: 'unknown', reason: 'En Argentina un celular escrito sin el 9 es igual a un fijo: el número no dice cuál es.' };
        return { country: iso, kind: 'unknown', reason: 'El número no dice si es celular: se envía y se aprende del resultado.' };
    }
  }

  function apolloPhoneType(snapshot, phone) {
    var nums = snapshot && snapshot.phone_numbers;
    if (!Array.isArray(nums)) return null;
    var key = reachKey(phone);
    if (!key) return null;
    for (var i = 0; i < nums.length; i++) {
      var n = nums[i];
      var k = reachKey(n && (n.sanitized_number || n.raw_number));
      if (k && k === key && n && typeof n.type === 'string') return n.type;
    }
    return null;
  }

  var NO_WHATSAPP_CODES = ['131026'];
  var NO_WHATSAPP_TEXT = /message undeliverable|not (a )?(valid )?whatsapp (user|number|account)|invalid whatsapp (number|contact)|not registered (on|with|in) whatsapp|no (tiene|est[aá] en) whatsapp/i;

  function noWhatsappCode(detail) {
    var text = String(detail == null ? '' : detail);
    for (var i = 0; i < NO_WHATSAPP_CODES.length; i++) {
      if (new RegExp('(^|\\D)' + NO_WHATSAPP_CODES[i] + '(\\D|$)').test(text)) return NO_WHATSAPP_CODES[i];
    }
    return NO_WHATSAPP_TEXT.test(text) ? 'not_on_whatsapp' : null;
  }

  var REACH_LABELS = {
    confirmed: 'WhatsApp confirmado',
    probable: 'Probable WhatsApp',
    unknown: 'Por confirmar',
    fixed: 'Fijo',
    switchboard: 'Conmutador',
    no_whatsapp: 'Sin WhatsApp (confirmado)',
    no_phone: 'Sin teléfono',
  };

  function whatsappReach(input) {
    function out(status, reason, send) { return { status: status, label: REACH_LABELS[status], reason: reason, send: send }; }
    if (!phoneDigits(input.phone)) return out('no_phone', 'El lead no tiene teléfono.', false);
    var learned = input.learned;
    if (learned && learned.status === 'no_whatsapp') {
      var code = learned.code && /^\d+$/.test(learned.code) ? ' (#' + learned.code + ')' : '';
      return out('no_whatsapp', 'WhatsApp no entregó un envío anterior a este número' + code + ': no está en WhatsApp, bloqueó tu número o no aceptó los términos. Ninguna campaña vuelve a intentarlo.', false);
    }
    if (learned && learned.status === 'has_whatsapp') return out('confirmed', 'Este número ya recibió o envió un WhatsApp.', true);
    var line = lineType(input.phone, input.country, input.providerType);
    if (line.kind === 'landline') return out('fixed', line.reason + ' Un fijo no recibe la plantilla.', false);
    if (line.kind === 'switchboard') return out('switchboard', line.reason, false);
    if (line.kind === 'mobile') return out('probable', line.reason, true);
    return out('unknown', line.reason, true);
  }

  function reachSummary(reaches, templateSteps) {
    var steps = templateSteps == null ? 1 : templateSteps;
    var s = { total: reaches.length, confirmed: 0, probable: 0, unknown: 0, fixed: 0, switchboard: 0, no_whatsapp: 0, no_phone: 0, avoided: 0 };
    reaches.forEach(function (r) { s[r.status]++; });
    s.avoided = (s.fixed + s.switchboard + s.no_whatsapp) * Math.max(0, Math.floor(steps));
    return s;
  }

  // ── Solo navegador ────────────────────────────────────────────────────────

  /** Veredicto para una fila de prospect_list_members con el mapa de lo aprendido. */
  function memberReach(m, learned) {
    var phone = m && m.phone;
    var stored = m && m.phone_type && m.phone_type !== 'unknown' ? m.phone_type : null;
    return whatsappReach({
      phone: phone,
      country: m && m.country,
      providerType: stored || apolloPhoneType(m && m.snapshot, phone),
      learned: (learned && phone && learned.get(reachKey(phone))) || null,
    });
  }

  /** Lo aprendido de los envíos (whatsapp_reachability) como Map phone_key → fila. */
  async function loadLearned() {
    var map = new Map();
    var client = global.supabaseClient;
    if (!client || typeof client.from !== 'function') return map;
    var PAGE = 1000;
    for (var from = 0; ; from += PAGE) {
      try {
        var res = await client.from('whatsapp_reachability')
          .select('phone_key, status, code, detail, observed_at')
          .order('phone_key')
          .range(from, from + PAGE - 1);
        if (res.error) return map; // sin la migración: solo el tipo de línea
        (res.data || []).forEach(function (r) { map.set(r.phone_key, r); });
        if (!res.data || res.data.length < PAGE) break;
      } catch (_) { return map; }
    }
    return map;
  }

  global.PhoneLines = {
    REACH_LABELS: REACH_LABELS, NO_WHATSAPP_CODES: NO_WHATSAPP_CODES,
    phoneDigits: phoneDigits, reachKey: reachKey, lineType: lineType,
    apolloPhoneType: apolloPhoneType, noWhatsappCode: noWhatsappCode, whatsappReach: whatsappReach,
    reachSummary: reachSummary, memberReach: memberReach, loadLearned: loadLearned,
  };
})(typeof window !== 'undefined' ? window : globalThis);
