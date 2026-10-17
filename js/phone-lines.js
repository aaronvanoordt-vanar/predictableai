/**
 * js/phone-lines.js — ¿el número del lead está en WhatsApp? (2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ ESPEJO EXACTO de supabase/functions/_shared/phone-lines.ts (planes de
 *   numeración con sus fuentes, reglas y textos). Se cambian juntos en el
 *   mismo PR: `deno test` (_shared/phone-lines.test.ts) evalúa este archivo y
 *   compara cada caso con el TS.
 *
 * Lo usan Listas (indicador por contacto) y el enrolamiento de Campañas
 * (cuántas plantillas no se mandan). Lo aprendido de los envíos vive en la
 * tabla `whatsapp_reachability` (solo la escribe el motor); `loadLearned`
 * la lee con la RLS del usuario y, si la tabla no existe aún, devuelve un
 * mapa vacío (la heurística sigue funcionando).
 *
 * Public API (global `PhoneLines`): countryOf, phoneDigits, reachKey, lineType,
 * apolloPhoneType, noWhatsappCode, whatsappReach, reachSummary, REACH_LABELS,
 * memberReach, loadLearned.
 */
(function (global) {
  'use strict';

  var COUNTRY_CALLING_CODES = { MX: '52', CO: '57', CL: '56', PE: '51', AR: '54', BR: '55' };
  var COUNTRY_NAMES = {
    mexico: 'MX', mx: 'MX', colombia: 'CO', co: 'CO', chile: 'CL', cl: 'CL',
    peru: 'PE', pe: 'PE', argentina: 'AR', ar: 'AR', brazil: 'BR', brasil: 'BR', br: 'BR',
  };

  function countryOf(raw) {
    var k = String(raw == null ? '' : raw).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return COUNTRY_NAMES[k] || null;
  }

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

  var MX_UNKNOWN = 'En México fijos y celulares comparten los 10 dígitos desde 2019: el número no dice cuál es.';
  var AR_UNKNOWN = 'En Argentina un celular escrito sin el 9 es igual a un fijo: el número no dice cuál es.';

  function classifyNational(country, n) {
    function r(kind, reason) { return { country: country, kind: kind, reason: reason }; }
    switch (country) {
      case 'MX':
        if (/^1\d{10}$/.test(n)) return r('mobile', 'Celular de México en formato de WhatsApp (52 1).');
        if (/^(800|900)\d{7}$/.test(n)) return r('fixed', 'Número 800/900 de México: es una línea de empresa, no un celular.');
        if (/^\d{10}$/.test(n)) return r('unknown', MX_UNKNOWN);
        return null;
      case 'CO':
        if (/^3\d{9}$/.test(n)) return r('mobile', 'Celular de Colombia (empieza con 3).');
        if (/^60\d{8}$/.test(n)) return r('fixed', 'Fijo de Colombia (60 + indicativo).');
        if (/^(01)?800\d{7}$/.test(n)) return r('fixed', 'Línea 01 8000 de Colombia: es de empresa, no un celular.');
        if (/^[1-8]\d{7}$/.test(n)) return r('fixed', 'Fijo de Colombia en el formato anterior a 2021 (indicativo + 7).');
        return null;
      case 'CL':
        if (/^9\d{8}$/.test(n)) return r('mobile', 'Celular de Chile (empieza con 9).');
        if (/^44\d{7}$/.test(n)) return r('unknown', 'Número VoIP de Chile (44): puede o no tener WhatsApp.');
        if (/^800\d{6}$/.test(n)) return r('fixed', 'Línea 800 de Chile: es de empresa, no un celular.');
        if (/^[2-7]\d{8}$/.test(n)) return r('fixed', 'Fijo de Chile (código de área).');
        return null;
      case 'PE':
        if (/^9\d{8}$/.test(n)) return r('mobile', 'Celular de Perú (9 dígitos, empieza con 9).');
        if (/^1\d{7}$/.test(n)) return r('fixed', 'Fijo de Lima (1 + 7 dígitos).');
        if (/^[4-8]\d{7}$/.test(n)) return r('fixed', 'Fijo de provincia de Perú (código de área + 6).');
        if (/^800\d{5}$/.test(n)) return r('fixed', 'Línea 0800 de Perú: es de empresa, no un celular.');
        return null;
      case 'AR':
        if (/^9\d{10}$/.test(n)) return r('mobile', 'Celular de Argentina (54 9).');
        if (/^(800|810)\d{7}$/.test(n)) return r('fixed', 'Línea 0800/0810 de Argentina: es de empresa, no un celular.');
        if (/^\d{12}$/.test(n) && [2, 3, 4].some(function (a) { return n.slice(a, a + 2) === '15' && /^[1-9]/.test(n); })) {
          return r('mobile', 'Celular de Argentina en formato local (con 15).');
        }
        if (/^\d{10}$/.test(n)) return r('unknown', AR_UNKNOWN);
        return null;
      case 'BR':
        if (/^0?800\d{6,7}$/.test(n)) return r('fixed', 'Línea 0800 de Brasil: es de empresa, no un celular.');
        if (/^[1-9][1-9]9\d{8}$/.test(n)) return r('mobile', 'Celular de Brasil (DDD + 9).');
        if (/^[1-9][1-9][2-5]\d{7}$/.test(n)) return r('fixed', 'Fijo de Brasil (DDD + 8 dígitos que empiezan con 2–5).');
        if (/^[1-9][1-9][6-9]\d{7}$/.test(n)) return r('mobile', 'Celular de Brasil en el formato de 8 dígitos (antes del nono dígito).');
        return null;
    }
    return null;
  }

  function lineType(phone, country) {
    var d = phoneDigits(phone);
    if (!d) return { country: null, kind: 'unknown', reason: 'Sin teléfono.' };
    var hint = countryOf(country);
    var international = /^\s*(\+|00)/.test(String(phone == null ? '' : phone));
    var tries = [];
    if (hint && !international) {
      var hcc = COUNTRY_CALLING_CODES[hint];
      if (d.indexOf(hcc) === 0) tries.push([hint, d.slice(hcc.length)]);
      tries.push([hint, d.replace(/^0(?=\d{8,})/, '')]);
    }
    Object.keys(COUNTRY_CALLING_CODES).forEach(function (iso) {
      var cc = COUNTRY_CALLING_CODES[iso];
      if (d.indexOf(cc) === 0) tries.push([iso, d.slice(cc.length)]);
    });
    for (var i = 0; i < tries.length; i++) {
      var hit = classifyNational(tries[i][0], tries[i][1]);
      if (hit) return hit;
    }
    return { country: null, kind: 'unknown', reason: 'País sin plan de numeración cargado: no se sabe si es celular.' };
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
    var line = lineType(input.phone, input.country);
    if (line.kind === 'fixed') return out('fixed', line.reason + ' Un fijo no recibe la plantilla.', false);
    if (line.kind === 'mobile') return out('probable', line.reason, true);
    var t = String(input.apolloType == null ? '' : input.apolloType).toLowerCase();
    if (t === 'mobile') return out('probable', 'Apollo lo marca como celular.', true);
    if (t === 'work_hq') return out('fixed', 'Apollo lo marca como el conmutador de la empresa: no es el WhatsApp de la persona.', false);
    return out('unknown', line.reason, true);
  }

  function reachSummary(reaches, templateSteps) {
    var steps = templateSteps == null ? 1 : templateSteps;
    var s = { total: reaches.length, confirmed: 0, probable: 0, unknown: 0, fixed: 0, no_whatsapp: 0, no_phone: 0, avoided: 0 };
    reaches.forEach(function (r) { s[r.status]++; });
    s.avoided = (s.fixed + s.no_whatsapp) * Math.max(0, Math.floor(steps));
    return s;
  }

  // ── Solo navegador ────────────────────────────────────────────────────────

  /** Veredicto para una fila de prospect_list_members con el mapa de lo aprendido. */
  function memberReach(m, learned) {
    var phone = m && m.phone;
    return whatsappReach({
      phone: phone,
      country: m && m.country,
      apolloType: apolloPhoneType(m && m.snapshot, phone),
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
        if (res.error) return map; // sin la migración: solo heurística
        (res.data || []).forEach(function (r) { map.set(r.phone_key, r); });
        if (!res.data || res.data.length < PAGE) break;
      } catch (_) { return map; }
    }
    return map;
  }

  global.PhoneLines = {
    COUNTRY_CALLING_CODES: COUNTRY_CALLING_CODES, REACH_LABELS: REACH_LABELS, NO_WHATSAPP_CODES: NO_WHATSAPP_CODES,
    countryOf: countryOf, phoneDigits: phoneDigits, reachKey: reachKey, lineType: lineType,
    apolloPhoneType: apolloPhoneType, noWhatsappCode: noWhatsappCode, whatsappReach: whatsappReach,
    reachSummary: reachSummary, memberReach: memberReach, loadLearned: loadLearned,
  };
})(typeof window !== 'undefined' ? window : globalThis);
