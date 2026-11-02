// Static parts of the HTML report: the CSP, the stylesheet and the inline script. Nothing here is built
// from log data. Colours are the validated reference palette of the dataviz method (light and dark
// steps of the same eight hues, fixed order), as tokens on :root.

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export const CSS = `
:root {
  color-scheme: light;
  --page: #f4f3ee;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #6f6d67;
  --grid: #e1e0d9;
  --rule: #c3c2b7;
  --track: #ecebe5;
  --ring: rgba(11, 11, 11, 0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948;
  --other: #a9a7a0;
  --warn-ink: #8a4b00;
  --warn-bg: #fdf3e2;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #9a9890;
    --grid: #2c2c2a; --rule: #383835; --track: #242422; --ring: rgba(255, 255, 255, 0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
    --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
    --other: #5f5e59; --warn-ink: #f2c46d; --warn-bg: #2a2214;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #9a9890;
  --grid: #2c2c2a; --rule: #383835; --track: #242422; --ring: rgba(255, 255, 255, 0.10);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
  --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  --other: #5f5e59; --warn-ink: #f2c46d; --warn-bg: #2a2214;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 var(--sans); }
.page { max-width: 1120px; margin: 0 auto; padding: 28px 16px 48px; }
a { color: inherit; }
h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: -0.01em; }
.mono, .num, td.n, .tile .v, .bars .bv, code { font-family: var(--mono); font-variant-numeric: tabular-nums; }
code { font-size: 0.92em; }

.masthead { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px 10px 0 0; padding: 22px 24px 18px; position: relative; }
.masthead::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; border-bottom: 2px dashed var(--rule); }
.brand { font: 600 12px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.brand .ver { color: var(--muted); letter-spacing: 0.04em; text-transform: none; font-weight: 400; }
.masthead h1 { font-size: 26px; margin-top: 10px; }
.masthead .meta { margin: 6px 0 0; color: var(--ink-2); font-size: 14px; }
.badge { display: inline-block; font: 600 11px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; padding: 5px 8px; border-radius: 4px; border: 1px solid var(--rule); color: var(--ink-2); }
.toc { background: var(--surface); border: 1px solid var(--ring); border-top: 0; border-radius: 0 0 10px 10px; padding: 10px 24px 12px; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; }
.toc a { color: var(--ink-2); text-decoration: none; }
.toc a:hover { color: var(--ink); text-decoration: underline; }
.toc .num { color: var(--muted); margin-right: 4px; }

section { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 22px 24px 24px; margin-top: 18px; }
section > h2 { font-size: 19px; display: flex; align-items: baseline; gap: 10px; }
section > h2 .num { font-size: 12px; font-weight: 500; color: var(--muted); }
.lede { color: var(--ink-2); margin: 6px 0 16px; max-width: 70ch; font-size: 14px; }
h3 { font-size: 14px; margin: 22px 0 10px; color: var(--ink-2); font-weight: 600; }

.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.tile { border: 1px solid var(--grid); border-radius: 8px; padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tile .k { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-2); }
.tile .v { font-size: 28px; line-height: 1.15; font-weight: 600; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.tile .s { font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
.tile .meter { margin-top: 6px; width: 100%; height: 6px; display: block; }
.tile.wide { grid-column: span 2; }
.tile.def { background: var(--page); }
.def-title { font-weight: 650; font-size: 13px; }
.def p { margin: 2px 0 0; font-size: 13px; color: var(--ink-2); }
.tile.alert { border-color: var(--rule); background: var(--warn-bg); }
.tile.alert .v { color: var(--warn-ink); }

.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.bars li { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 3fr) minmax(5.5em, auto); gap: 12px; align-items: center; }
.bars .bl { min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.bars .bl small { color: var(--muted); font-size: 12px; margin-left: 6px; }
.bars svg { width: 100%; height: 14px; display: block; }
.bars .bv { text-align: right; font-size: 13px; white-space: nowrap; }
rect.track { fill: var(--track); }
.bar.s1, .sw.s1 { fill: var(--s1); background: var(--s1); }
.bar.s2, .sw.s2 { fill: var(--s2); background: var(--s2); }
.bar.s3, .sw.s3 { fill: var(--s3); background: var(--s3); }
.bar.s4, .sw.s4 { fill: var(--s4); background: var(--s4); }
.bar.s5, .sw.s5 { fill: var(--s5); background: var(--s5); }
.bar.s6, .sw.s6 { fill: var(--s6); background: var(--s6); }
.bar.s7, .sw.s7 { fill: var(--s7); background: var(--s7); }
.bar.s8, .sw.s8 { fill: var(--s8); background: var(--s8); }
.bar.so, .sw.so { fill: var(--other); background: var(--other); }
.stack-row { display: grid; grid-template-columns: 7.5em minmax(0, 1fr); gap: 12px; align-items: center; margin: 6px 0; }
.stack-row .lab { font-size: 13px; color: var(--ink-2); }
svg.stack { width: 100%; height: 26px; display: block; }
svg.stack rect { stroke: var(--surface); stroke-width: 2; vector-effect: non-scaling-stroke; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 8px; }

.split { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 8px 32px; }
.split > * { min-width: 0; }
.table-wrap { overflow-x: auto; margin-top: 4px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--grid); text-align: left; vertical-align: top; }
th { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-2); border-bottom-color: var(--rule); white-space: nowrap; }
th button { all: unset; cursor: pointer; }
th button:focus-visible { outline: 2px solid var(--s1); outline-offset: 2px; }
th[aria-sort] button::after { content: " \\25BE"; color: var(--muted); }
th[aria-sort="ascending"] button::after { content: " \\25B4"; }
td.n, th.n { text-align: right; padding-right: 18px; padding-left: 10px; white-space: nowrap; }
td.n:last-child, th.n:last-child { padding-right: 0; }
td.path { font-family: var(--mono); overflow-wrap: anywhere; }
td.mono, td code { white-space: nowrap; }
td.nowrap { white-space: nowrap; }
td.wide { min-width: 16em; }
tr:last-child td { border-bottom: 0; }
.chip { display: inline-block; font: 500 11px/1.6 var(--mono); padding: 0 6px; border-radius: 4px; border: 1px solid var(--grid); color: var(--ink-2); white-space: nowrap; }
.chip.merged { border-color: var(--s3); }
.chip.closedUnmerged, .chip.noPr { border-color: var(--s2); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 10px 20px; margin: 4px 0 8px; }
.fact .k { font-size: 12px; color: var(--ink-2); }
.fact .v { font: 600 17px/1.3 var(--mono); }
.empty { color: var(--muted); font-size: 14px; margin: 4px 0; }
.notes { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: var(--ink-2); }
.notes li { margin: 3px 0; overflow-wrap: anywhere; }
dl.defs { margin: 16px 0 0; display: grid; grid-template-columns: minmax(0, 11em) minmax(0, 1fr); gap: 8px 18px; font-size: 14px; }
dl.defs dt { font-weight: 600; }
dl.defs dd { margin: 0; color: var(--ink-2); }
footer { margin-top: 18px; color: var(--muted); font-size: 12px; text-align: center; }

@media (max-width: 860px) {
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .tiles { grid-template-columns: minmax(0, 1fr); }
  .page { padding-top: 16px; }
  .masthead, .toc, section { padding-left: 16px; padding-right: 16px; }
  .masthead h1 { font-size: 22px; }
  .tile.wide { grid-column: auto; }
  .tile .v { font-size: 24px; }
  .bars li { grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; }
  .bars .bl { grid-column: 1 / -1; }
  .stack-row { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  dl.defs { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  dl.defs dd { margin-bottom: 8px; }
}
@media print {
  body { background: #fff; }
  section, .masthead, .toc { break-inside: avoid; border-color: #ccc; }
  th button::after { content: none; }
}
`;

/**
 * Sortable tables. Reads only `data-v` attributes and `textContent`, moves existing rows; it never
 * parses or writes markup.
 */
export const SCRIPT = `
(function () {
  'use strict';
  var tables = document.querySelectorAll('table.sortable');
  Array.prototype.forEach.call(tables, function (table) {
    var heads = table.querySelectorAll('thead th');
    Array.prototype.forEach.call(heads, function (th, col) {
      var label = th.textContent;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      th.textContent = '';
      th.appendChild(btn);
      btn.addEventListener('click', function () {
        var asc = th.getAttribute('aria-sort') === 'descending';
        Array.prototype.forEach.call(heads, function (h) { h.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
        var body = table.tBodies[0];
        var rows = Array.prototype.slice.call(body.rows);
        var key = function (row) {
          var cell = row.cells[col];
          if (!cell) return '';
          var v = cell.getAttribute('data-v');
          return v !== null ? Number(v) : cell.textContent.toLowerCase();
        };
        rows.sort(function (a, b) {
          var x = key(a), y = key(b);
          var d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
          return asc ? d : -d;
        });
        rows.forEach(function (row) { body.appendChild(row); });
      });
    });
  });
})();
`;
