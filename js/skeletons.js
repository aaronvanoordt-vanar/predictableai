/**
 * skeletons.js — shared skeleton-loader builders.
 *
 * Exposes window.Skeleton: small primitives + a few composed patterns that
 * return HTML strings, so any surface can drop in a loading placeholder that
 * mirrors the real layout while genuine async data (Supabase / Apollo / LLM)
 * is in flight. These are NOT artificial delays — mount them right before a
 * fetch and replace them with real content (or an honest empty state) the
 * moment it resolves. CSS lives in index.html (.sk / .sk-* classes).
 */
(function () {
  'use strict';

  // Accept 200 -> "200px", "60%" -> "60%", "" -> "".
  function dim(v) {
    if (v == null || v === '') return '';
    return typeof v === 'number' ? v + 'px' : String(v);
  }
  function styleStr(props) {
    return Object.keys(props)
      .filter(function (k) { return props[k] !== '' && props[k] != null; })
      .map(function (k) { return k + ':' + props[k]; })
      .join(';');
  }

  // ── Primitives ────────────────────────────────────────────────
  // A single shimmer line. w/h accept number(px) or css string.
  function line(w, h, extra) {
    var s = styleStr({ width: dim(w) || '100%', height: dim(h) || '12px' });
    return '<span class="sk sk-line" style="' + s + (extra ? ';' + extra : '') + '"></span>';
  }
  function block(w, h, extra) {
    var s = styleStr({ width: dim(w) || '100%', height: dim(h) || '80px' });
    return '<span class="sk sk-block" style="' + s + (extra ? ';' + extra : '') + '"></span>';
  }
  function circle(size) {
    var d = dim(size) || '36px';
    return '<span class="sk sk-circle" style="width:' + d + ';height:' + d + '"></span>';
  }

  // A few text lines of decreasing width (paragraph placeholder).
  function paragraph(lines) {
    var n = lines || 3, out = [];
    for (var i = 0; i < n; i++) {
      var w = i === n - 1 ? '55%' : (i === 0 ? '92%' : '100%');
      out.push(line(w, 11, 'margin-bottom:9px'));
    }
    return '<div>' + out.join('') + '</div>';
  }

  // ── Composed patterns ─────────────────────────────────────────
  // Stat / KPI cards: label + big value + sub line.
  function statCards(n, opts) {
    opts = opts || {};
    var min = opts.min || 180;
    var cards = [];
    for (var i = 0; i < (n || 3); i++) {
      cards.push(
        '<div class="sk-card">' +
          line(70, 11) +
          line('55%', 26, 'margin-top:4px') +
          line('38%', 10) +
        '</div>');
    }
    return '<div class="sk-grid" style="grid-template-columns:repeat(auto-fit,minmax(' + min +
      'px,1fr))">' + cards.join('') + '</div>';
  }

  // Generic content cards (title + paragraph). Good for hub/report cards.
  function cards(n, opts) {
    opts = opts || {};
    var lines = opts.lines || 3;
    var out = [];
    for (var i = 0; i < (n || 3); i++) {
      out.push('<div class="sk-card">' + line('60%', 14) + paragraph(lines) + '</div>');
    }
    if (opts.grid) {
      return '<div class="sk-grid" style="grid-template-columns:repeat(auto-fit,minmax(' +
        (opts.min || 240) + 'px,1fr))">' + out.join('') + '</div>';
    }
    return '<div class="sk-grid">' + out.join('') + '</div>';
  }

  // List rows: avatar + two stacked lines. For member/lead/list rows.
  function listRows(n, opts) {
    opts = opts || {};
    var avatar = opts.avatar !== false;
    var out = [];
    for (var i = 0; i < (n || 4); i++) {
      out.push(
        '<div class="sk-row" style="padding:12px 14px;border:1px solid var(--hair);' +
          'border-radius:var(--r-md);background:var(--surface)">' +
          (avatar ? circle(34) : '') +
          '<div style="flex:1;display:flex;flex-direction:column;gap:7px">' +
            line((55 + (i % 3) * 10) + '%', 12) +
            line((30 + (i % 2) * 10) + '%', 10) +
          '</div>' +
          (opts.trailing ? line(48, 20) : '') +
        '</div>');
    }
    return '<div style="display:flex;flex-direction:column;gap:8px">' + out.join('') + '</div>';
  }

  // Table body rows (<tr>). colWidths: array of css widths per column.
  function tableRows(colWidths, rowCount) {
    var cols = colWidths || ['40%', '30%', '50%', '35%'];
    var rows = [];
    for (var r = 0; r < (rowCount || 6); r++) {
      var cells = cols.map(function (w, ci) {
        // vary width slightly per row so it reads organic, not striped
        var base = parseInt(w, 10) || 40;
        var jitter = Math.max(20, Math.min(96, base + ((r + ci) % 3 - 1) * 8));
        return '<td>' + line(jitter + '%', 11) + '</td>';
      }).join('');
      rows.push('<tr>' + cells + '</tr>');
    }
    return rows.join('');
  }

  // A whole table-card placeholder (header + rows) as one block.
  function tableCard(opts) {
    opts = opts || {};
    var cols = opts.cols || 4;
    var colWidths = [];
    for (var i = 0; i < cols; i++) colWidths.push((30 + (i % 3) * 15) + '%');
    var head = '';
    if (opts.title !== false) {
      head = '<div class="table-head">' + line(160, 14) + '</div>';
    }
    return '<div class="table-card">' + head +
      '<table><tbody>' + tableRows(colWidths, opts.rows || 6) + '</tbody></table></div>';
  }

  window.Skeleton = {
    line: line,
    block: block,
    circle: circle,
    paragraph: paragraph,
    statCards: statCards,
    cards: cards,
    listRows: listRows,
    tableRows: tableRows,
    tableCard: tableCard
  };
})();
