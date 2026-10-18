/**
 * js/phone-latam.js — teléfonos latinoamericanos → E.164 + tipo de línea.
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ ESPEJO EXACTO de supabase/functions/_shared/phone-latam.ts (el
 *   normalizador del waterfall: planes de numeración, limpieza de prefijos
 *   viejos, tipo mobile / landline / switchboard / unknown). Se cambian juntos
 *   en el mismo PR: `deno test` (_shared/phone-lines.test.ts) evalúa este
 *   archivo y compara normalizePhone caso por caso con el TS.
 *
 * Lo usa js/phone-lines.js para que el indicador de WhatsApp de Listas y del
 * enrolamiento diga lo mismo que campaign-run, también en las filas
 * anteriores al waterfall (sin `phone_type` guardado).
 *
 * Public API (global `PhoneLatam`): normalizePhone, countryIso,
 * providerPhoneType, whatsappCapable.
 */
(function (global) {
  'use strict';

  function TOLL(prefixes) { return function (nsn) { return prefixes.some(function (p) { return nsn.indexOf(p) === 0; }); }; }

  var COUNTRIES = {
    MX: {
      cc: '52', lengths: [10],
      classify: function (n) { return TOLL(['800', '900'])(n) ? 'switchboard' : 'unknown'; },
      pre: function (n) { return /^04[45]\d{10}$/.test(n) ? { nsn: n.slice(3), type: 'mobile' } : /^01\d{10}$/.test(n) ? { nsn: n.slice(2) } : null; },
      fix: function (n) { return /^1\d{10}$/.test(n) ? { nsn: n.slice(1), type: 'mobile' } : { nsn: n }; },
    },
    AR: {
      cc: '54', lengths: [10, 11],
      classify: function (n) {
        if (TOLL(['800', '810', '600'])(n)) return 'switchboard';
        if (n.length === 11 && n.indexOf('9') === 0) return 'mobile';
        return 'unknown';
      },
      fix: function (n, intl, hint) {
        if (/^9\d{10}$/.test(n)) return { nsn: n, type: 'mobile' };
        if (/^(800|810|600)/.test(n)) return { nsn: n };
        if (n.length === 12) {
          var ats = n.indexOf('11') === 0 ? [2] : [3, 4, 2];
          for (var i = 0; i < ats.length; i++) {
            var at = ats[i];
            if (n.slice(at, at + 2) === '15') return { nsn: '9' + n.slice(0, at) + n.slice(at + 2), type: 'mobile' };
          }
        }
        if (n.length === 10) {
          if (hint === 'mobile') return { nsn: '9' + n, type: 'mobile' };
          return { nsn: n, type: intl ? (hint === 'landline' ? 'landline' : 'unknown') : 'landline' };
        }
        return { nsn: n };
      },
    },
    BR: {
      cc: '55', lengths: [10, 11],
      classify: function (n) {
        if (/^(800|300|303)\d{7}$/.test(n) || /^(4003|4004|3003)\d{4}$/.test(n)) return 'switchboard';
        if (/^\d{2}9\d{8}$/.test(n)) return 'mobile';
        if (/^\d{2}[2-5]\d{7}$/.test(n)) return 'landline';
        return 'unknown';
      },
      fix: function (n) {
        if (/^(800|300|303)\d{7}$/.test(n) || /^(4003|4004|3003)\d{4}$/.test(n)) return { nsn: n };
        if (n.length === 12 || n.length === 13) n = n.slice(2);
        if (/^\d{2}[6-9]\d{7}$/.test(n)) return { nsn: n.slice(0, 2) + '9' + n.slice(2), type: 'mobile' };
        return { nsn: n };
      },
    },
    CO: {
      cc: '57', lengths: [10, 11],
      classify: function (n) {
        if (/^18000\d{6}$/.test(n)) return 'switchboard';
        if (/^3\d{9}$/.test(n)) return 'mobile';
        if (/^60\d{8}$/.test(n)) return 'landline';
        return 'unknown';
      },
      fix: function (n) {
        if (/^0?18000\d{6}$/.test(n)) return { nsn: n.replace(/^0/, '') };
        if (/^[1-8]\d{7}$/.test(n)) return { nsn: '60' + n, type: 'landline' };
        if (/^3[1-8]\d{7}$/.test(n) && n.length === 9) return { nsn: '60' + n.slice(1), type: 'landline' };
        return { nsn: n };
      },
    },
    CL: {
      cc: '56', lengths: [9, 10],
      classify: function (n) {
        if (/^(600|800)\d{7}$/.test(n)) return 'switchboard';
        if (/^9\d{8}$/.test(n)) return 'mobile';
        if (/^[2-8]\d{8}$/.test(n)) return 'landline';
        return 'unknown';
      },
    },
    PE: {
      cc: '51', lengths: [8, 9],
      classify: function (n) {
        if (/^80[01]\d{5}$/.test(n)) return 'switchboard';
        if (/^9\d{8}$/.test(n)) return 'mobile';
        if (/^[1-8]\d{7}$/.test(n)) return 'landline';
        return 'unknown';
      },
    },
    EC: {
      cc: '593', lengths: [8, 9, 10],
      classify: function (n) {
        if (/^1800\d{6}$/.test(n)) return 'switchboard';
        if (/^9\d{8}$/.test(n)) return 'mobile';
        if (/^[2-7]\d{7}$/.test(n)) return 'landline';
        return 'unknown';
      },
    },
    UY: {
      cc: '598', lengths: [7, 8],
      classify: function (n) {
        if (/^80[0-9]\d{4}$/.test(n)) return 'switchboard';
        if (/^9\d{7}$/.test(n)) return 'mobile';
        if (/^[24]\d{7}$/.test(n)) return 'landline';
        return 'unknown';
      },
    },
    PY: {
      cc: '595', lengths: [8, 9],
      classify: function (n) { return /^9\d{8}$/.test(n) ? 'mobile' : /^[2-8]\d{6,8}$/.test(n) ? 'landline' : 'unknown'; },
    },
    BO: {
      cc: '591', lengths: [8],
      classify: function (n) { return /^800\d{5}$/.test(n) ? 'switchboard' : /^[67]\d{7}$/.test(n) ? 'mobile' : /^[2-4]\d{7}$/.test(n) ? 'landline' : 'unknown'; },
    },
    VE: {
      cc: '58', lengths: [10],
      classify: function (n) { return /^800\d{7}$/.test(n) ? 'switchboard' : /^4\d{9}$/.test(n) ? 'mobile' : /^2\d{9}$/.test(n) ? 'landline' : 'unknown'; },
    },
    CR: {
      cc: '506', lengths: [8, 10],
      classify: function (n) { return /^800\d{7}$/.test(n) ? 'switchboard' : /^[5-8]\d{7}$/.test(n) ? 'mobile' : /^2\d{7}$/.test(n) ? 'landline' : 'unknown'; },
    },
    PA: {
      cc: '507', lengths: [7, 8],
      classify: function (n) { return /^800\d{4}$/.test(n) ? 'switchboard' : /^6\d{7}$/.test(n) ? 'mobile' : /^[2-9]\d{6}$/.test(n) ? 'landline' : 'unknown'; },
    },
    GT: {
      cc: '502', lengths: [8, 11],
      classify: function (n) { return /^1800\d{7}$/.test(n) ? 'switchboard' : /^[3-5]\d{7}$/.test(n) ? 'mobile' : /^[267]\d{7}$/.test(n) ? 'landline' : 'unknown'; },
    },
    SV: {
      cc: '503', lengths: [7, 8, 11],
      classify: function (n) { return /^800\d{4}$/.test(n) ? 'switchboard' : /^[67]\d{7}$/.test(n) ? 'mobile' : /^2\d{7}$/.test(n) ? 'landline' : 'unknown'; },
    },
    HN: {
      cc: '504', lengths: [8],
      classify: function (n) { return /^[3789]\d{7}$/.test(n) ? 'mobile' : /^2\d{7}$/.test(n) ? 'landline' : 'unknown'; },
    },
    NI: {
      cc: '505', lengths: [8],
      classify: function (n) { return /^[578]\d{7}$/.test(n) ? 'mobile' : /^2\d{7}$/.test(n) ? 'landline' : 'unknown'; },
    },
    ES: {
      cc: '34', lengths: [9],
      classify: function (n) { return /^90[0-2]\d{6}$/.test(n) || /^80\d{7}$/.test(n) ? 'switchboard' : /^[67]\d{8}$/.test(n) ? 'mobile' : /^[89]\d{8}$/.test(n) ? 'landline' : 'unknown'; },
    },
    US: {
      cc: '1', lengths: [10],
      classify: function (n) { return /^8(00|33|44|55|66|77|88)\d{7}$/.test(n) ? 'switchboard' : 'unknown'; },
    },
  };

  var BY_CC = Object.keys(COUNTRIES)
    .map(function (iso) { var r = COUNTRIES[iso]; return { iso: iso, cc: r.cc, lengths: r.lengths, classify: r.classify, fix: r.fix, pre: r.pre }; })
    .sort(function (a, b) { return b.cc.length - a.cc.length; });

  var NANP_AREAS = { '809': 'DO', '829': 'DO', '849': 'DO', '787': 'PR', '939': 'PR' };

  var COUNTRY_NAMES = {
    mexico: 'MX', 'méxico': 'MX', mx: 'MX',
    argentina: 'AR', ar: 'AR',
    brazil: 'BR', brasil: 'BR', br: 'BR',
    colombia: 'CO', co: 'CO',
    chile: 'CL', cl: 'CL',
    peru: 'PE', 'perú': 'PE', pe: 'PE',
    ecuador: 'EC', ec: 'EC',
    uruguay: 'UY', uy: 'UY',
    paraguay: 'PY', py: 'PY',
    bolivia: 'BO', bo: 'BO',
    venezuela: 'VE', ve: 'VE',
    'costa rica': 'CR', cr: 'CR',
    panama: 'PA', 'panamá': 'PA', pa: 'PA',
    guatemala: 'GT', gt: 'GT',
    'el salvador': 'SV', sv: 'SV',
    honduras: 'HN', hn: 'HN',
    nicaragua: 'NI', ni: 'NI',
    spain: 'ES', 'españa': 'ES', es: 'ES',
    'united states': 'US', 'estados unidos': 'US', usa: 'US', us: 'US',
    canada: 'US', 'canadá': 'US', ca: 'US',
    'dominican republic': 'US', 'república dominicana': 'US', do: 'US',
    'puerto rico': 'US', pr: 'US',
  };

  function countryIso(name) {
    var k = String(name == null ? '' : name).trim().toLowerCase();
    if (!k) return null;
    var iso = COUNTRY_NAMES[k] || COUNTRY_NAMES[k.normalize('NFD').replace(/[̀-ͯ]/g, '')];
    return iso || null;
  }

  function providerPhoneType(t) {
    var s = String(t == null ? '' : t).toLowerCase().replace(/[\s-]+/g, '_');
    if (!s) return 'unknown';
    if (/mobile|cell|movil|móvil|celular|wireless/.test(s)) return 'mobile';
    if (/hq|headquarter|switchboard|company|main|office_main|toll/.test(s)) return 'switchboard';
    if (/landline|fixed|fijo|home|direct|work|office|voip/.test(s)) return 'landline';
    return 'unknown';
  }

  function splitExtension(raw) {
    var m = raw.match(/^(.*?)(?:\s*(?:ext\.?|extensi[oó]n|ext|anexo|int\.?|x|#)\s*(\d{1,6}))\s*$/i);
    if (m && /\d{6,}/.test(m[1].replace(/\D/g, ''))) return { body: m[1], ext: m[2] };
    return { body: raw, ext: null };
  }

  function finish(iso, cc, nsn, type, ext, valid) {
    return { e164: '+' + cc + nsn, country: iso, type: ext && type !== 'mobile' ? 'switchboard' : type, extension: ext, valid: valid };
  }

  function normalizePhone(raw, opts) {
    opts = opts || {};
    var input = String(raw == null ? '' : raw).trim();
    if (!input) return null;
    var sp = splitExtension(input);
    var body = sp.body, ext = sp.ext;
    var hint = providerPhoneType(opts.type);
    var d = body.replace(/\D/g, '');
    if (d.length < 6) return null;
    var intl = /^\s*\+/.test(body);
    if (!intl && d.indexOf('00') === 0) { d = d.slice(2); intl = true; }

    var hintIso = countryIso(opts.country);
    var rule = null;
    var nsn = d;

    function looksIntl(r) {
      return d.indexOf(r.cc) === 0 && r.lengths.some(function (l) { return d.length - r.cc.length >= l; }) && d.length >= 10 + (r.cc === '1' ? 1 : 0);
    }
    if (intl) {
      rule = BY_CC.find(function (r) { return d.indexOf(r.cc) === 0; }) || null;
      if (rule) nsn = d.slice(rule.cc.length);
    } else {
      var hinted = null;
      if (hintIso) { var hr = COUNTRIES[hintIso]; hinted = { iso: hintIso, cc: hr.cc, lengths: hr.lengths, classify: hr.classify, fix: hr.fix, pre: hr.pre }; }
      if (hinted && looksIntl(hinted) && d.indexOf('0') !== 0) {
        rule = hinted; nsn = d.slice(hinted.cc.length); intl = true;
      } else if (hinted) {
        rule = hinted; nsn = d;
      } else {
        var guess = BY_CC.find(function (r) { return r.cc !== '1' && looksIntl(r) && d.length >= 11; });
        if (guess) { rule = guess; nsn = d.slice(guess.cc.length); intl = true; }
      }
    }

    if (!rule) {
      var ok = intl && d.length >= 8 && d.length <= 15;
      return { e164: '+' + d, country: null, type: ext ? 'switchboard' : hint, extension: ext, valid: ok };
    }

    var fixedType;
    var pre = !intl && rule.pre ? rule.pre(nsn) : null;
    if (pre) { nsn = pre.nsn; fixedType = pre.type; }
    nsn = nsn.replace(/^0+/, '');
    if (rule.fix) {
      var f = rule.fix(nsn, intl, hint);
      nsn = f.nsn;
      fixedType = f.type || fixedType;
    }
    var valid = rule.lengths.indexOf(nsn.length) !== -1;
    var iso = rule.iso;
    if (iso === 'US') iso = NANP_AREAS[nsn.slice(0, 3)] || (hintIso && hintIso !== 'US' ? hintIso : 'US');

    var byNumber = rule.classify(nsn);
    var type;
    if (byNumber === 'switchboard') type = 'switchboard';
    else if (hint === 'switchboard') type = 'switchboard';
    else if (byNumber !== 'unknown') type = byNumber;
    else if (fixedType && fixedType !== 'unknown') type = fixedType;
    else type = hint;
    return finish(iso, rule.cc, nsn, valid ? type : hint, ext, valid);
  }

  function whatsappCapable(p) {
    return !!p && p.valid && (p.type === 'mobile' || p.type === 'unknown');
  }

  global.PhoneLatam = {
    normalizePhone: normalizePhone, countryIso: countryIso,
    providerPhoneType: providerPhoneType, whatsappCapable: whatsappCapable,
  };
})(typeof window !== 'undefined' ? window : globalThis);
