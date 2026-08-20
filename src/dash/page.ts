/** The dashboard shell: static HTML/CSS/JS, data arrives via /data.json.
 *  Dark terminal theme; chains as tabs; verdicts in plain English; operations
 *  detail folded away so screenshots lead with the findings. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shadow Resolver</title>
<style>
  :root {
    --surface:#0E1114; --panel:#171B20; --ink:#E7EAEE; --ink-2:#9AA4B0; --ink-3:#5F6975;
    --line:#252B32; --accent:#8B9CF0; --accent-ink:#A6B3F5;
    --win:#4CC38A; --win-bg:#12291D; --lose:#F07862; --lose-bg:#2C1712;
    --warn:#D9A54A; --warn-bg:#2A2113; --chip:#21262D;
  }
  * { box-sizing:border-box; margin:0; }
  body {
    background:var(--surface); color:var(--ink);
    font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding:40px 28px 80px; max-width:1180px; margin:0 auto;
  }
  .num, td.num, .chip, .stat b { font-family:ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric:tabular-nums; }

  /* header */
  header { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:6px; }
  h1 { font-size:22px; font-weight:650; letter-spacing:-0.02em; }
  .sub { color:var(--ink-2); max-width:760px; margin-bottom:26px; }
  .htools { margin-left:auto; display:flex; gap:10px; align-items:center; }
  .stamp { color:var(--ink-3); font-size:12px; }
  #err { color:var(--lose); font-size:12.5px; }

  /* chain tabs */
  .tabs { display:inline-flex; border:1px solid var(--line); border-radius:9px; padding:3px; gap:3px; background:var(--panel); margin-bottom:26px; }
  .tab { border:0; border-radius:6px; background:transparent; color:var(--ink-3); font:inherit; font-size:13px; font-weight:550; padding:6px 16px; cursor:pointer; display:flex; align-items:center; gap:8px; }
  .tab:hover { color:var(--ink-2); }
  .tab.active { background:var(--chip); color:var(--ink); }
  .tab .dot { width:6px; height:6px; border-radius:50%; background:var(--win); }
  .tab .dot.bad { background:var(--lose); }
  .tab small { color:var(--ink-3); font-weight:450; }

  /* chain section */
  .chain { display:none; }
  .chain.active { display:block; }
  .chainmeta { color:var(--ink-3); font-size:12.5px; margin-bottom:18px; }

  /* scoreboard */
  .eyebrow { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); margin-bottom:10px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:14px; margin-bottom:26px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px 14px; }
  .card h3 { font-size:13px; font-weight:600; color:var(--ink-2); margin-bottom:10px; }
  .card .big { font-size:30px; font-weight:650; letter-spacing:-0.02em; line-height:1.1; }
  .card .big small { font-size:14px; font-weight:500; color:var(--ink-3); letter-spacing:0; }
  .card .rows { margin-top:10px; font-size:12.5px; color:var(--ink-2); display:grid; gap:3px; }
  .card .rows b { color:var(--ink); font-weight:550; }
  .ratio { display:flex; gap:2px; height:5px; border-radius:3px; overflow:hidden; margin-top:12px; }
  .ratio i { display:block; height:100%; }
  .ratio .w { background:var(--win); } .ratio .l { background:var(--lose); } .ratio .t { background:var(--ink-3); opacity:.45; }

  /* funnel */
  .funnel { display:flex; flex-wrap:wrap; gap:10px 26px; align-items:baseline; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 20px; margin-bottom:30px; }
  .stat { display:flex; align-items:baseline; gap:8px; }
  .stat b { font-size:19px; font-weight:650; }
  .stat span { color:var(--ink-2); font-size:12.5px; }
  .stat .usd { color:var(--ink-3); font-size:12px; }
  .arrow { color:var(--ink-3); }

  /* tables */
  h4 { font-size:13px; font-weight:600; color:var(--ink-2); margin:26px 0 10px; }
  table { border-collapse:collapse; width:100%; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  table { display:block; overflow-x:auto; }
  th { text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); font-weight:600; padding:10px 14px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:8px 14px; border-bottom:1px solid var(--line); white-space:nowrap; font-size:13px; }
  tr:last-child td { border-bottom:none; }
  td.num { text-align:right; }
  th.num { text-align:right; }
  .mut { color:var(--ink-3); }
  .empty { color:var(--ink-3); padding:14px; background:var(--panel); border:1px solid var(--line); border-radius:10px; }

  /* verdict chips */
  .chip { display:inline-block; border-radius:5px; padding:1.5px 8px; font-size:12px; white-space:nowrap; }
  .chip.win { background:var(--win-bg); color:var(--win); }
  .chip.late { background:var(--warn-bg); color:var(--warn); }
  .chip.short { background:var(--lose-bg); color:var(--lose); }
  .chip.thin, .chip.none { background:var(--chip); color:var(--ink-3); }

  /* auction decay bar */
  .decay { display:inline-flex; align-items:center; gap:8px; }
  .decay .bar { width:90px; height:4px; border-radius:2px; background:var(--chip); overflow:hidden; }
  .decay .bar i { display:block; height:100%; background:var(--accent); }
  .decay span { font-size:11.5px; color:var(--ink-3); }

  /* legend: floating trigger + centered modal */
  #legend-pill { position:fixed; right:22px; bottom:22px; z-index:10; background:var(--panel); color:var(--ink-2); border:1px solid var(--line); border-radius:20px; padding:7px 14px; font:inherit; font-size:12.5px; cursor:pointer; box-shadow:0 4px 16px rgba(0,0,0,.35); }
  #legend-pill:hover { color:var(--ink); border-color:var(--ink-3); }
  /* margin:auto restores the centering the global reset above stripped off */
  dialog#legend { margin:auto; width:min(92vw, 880px); max-height:88vh; overflow-y:auto; background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:14px; padding:26px 30px 24px; box-shadow:0 24px 64px rgba(0,0,0,.55); }
  dialog#legend:focus, dialog#legend:focus-visible { outline:none; }
  dialog#legend::backdrop { background:rgba(8,10,13,.62); backdrop-filter:blur(2px); }
  .lhead { display:flex; align-items:baseline; margin-bottom:20px; }
  .lhead b { font-size:16px; font-weight:650; letter-spacing:-0.01em; }
  .lhead button { margin-left:auto; background:none; border:0; color:var(--ink-3); font:inherit; font-size:20px; line-height:1; cursor:pointer; padding:2px 4px; }
  .lhead button:hover { color:var(--ink); }
  .lgroup { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); margin:18px 0 10px; }
  .lgroup:first-of-type { margin-top:0; }
  .lgrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); gap:8px 22px; }
  .lentry { padding:10px 0 8px; border-top:1px solid var(--line); }
  .lentry p { margin-top:6px; color:var(--ink-2); font-size:12.5px; line-height:1.5; }
  .lnote { margin-top:20px; padding-top:14px; border-top:1px solid var(--line); color:var(--ink-3); font-size:12px; line-height:1.5; }

  details { margin-top:22px; }
  summary { cursor:pointer; color:var(--ink-3); font-size:12.5px; letter-spacing:.06em; text-transform:uppercase; }
  details > div { margin-top:12px; display:grid; gap:18px; }
  .kv { color:var(--ink-2); font-size:12.5px; display:flex; flex-wrap:wrap; gap:6px 18px; }
  .kv b { color:var(--ink); font-weight:550; }
</style>
</head>
<body>
<header>
  <h1>Shadow Resolver</h1>
  <div class="htools"><span class="stamp" id="stamp"></span><span id="err"></span></div>
</header>
<p class="sub" id="sub"></p>
<nav class="tabs" id="tabs"></nav>
<div id="root" class="mut">loading…</div>

<button id="legend-pill" onclick="document.getElementById('legend').showModal()">What do the verdicts mean?</button>
<dialog id="legend">
  <div class="lhead"><b>What the verdicts mean</b><button onclick="document.getElementById('legend').close()" aria-label="close">×</button></div>
  <div class="lgroup">On decided auctions</div>
  <div class="lgrid">
    <div class="lentry"><span class="chip win">won +6.0 bps</span><p>Filling this order and hedging on this venue turned profitable <em>before</em> the real winner took it. The number is our margin at that first profitable moment.</p></div>
    <div class="lentry"><span class="chip win">won* +6.0 bps</span><p>Same as a win, but the price data behind it was a few seconds stale. Counted cautiously and excluded from headline numbers.</p></div>
    <div class="lentry"><span class="chip late">profitable too late</span><p>The auction did reach a price where we would profit, but only after someone else had already filled the order.</p></div>
    <div class="lentry"><span class="chip short">12.1 bps short</span><p>Never profitable on this venue. At its best moment, our all-in cost was still this many bps above what the hedge would pay.</p></div>
    <div class="lentry"><span class="chip thin">book too thin</span><p>The venue did not have enough liquidity to absorb the full order size, so no honest hedge price exists.</p></div>
    <div class="lentry"><span class="chip none">no data</span><p>No usable price for this order: the pair is not quoted on this venue, or our coverage began after the order was live.</p></div>
    <div class="lentry"><span class="chip none">no market</span><p>This trading pair has no market on this venue at all.</p></div>
    <div class="lentry"><span class="chip none">unfillable</span><p>The order itself was broken (bad signature, missing balance). Nobody could have filled it, so it counts for no venue.</p></div>
  </div>
  <div class="lgroup">On live auctions</div>
  <div class="lgrid">
    <div class="lentry"><span class="chip win">+3.2 bps</span><p>Filling right now would clear this margin after all costs.</p></div>
    <div class="lentry"><span class="chip short">-8.4 bps</span><p>Not yet profitable: how far the current auction price is from break-even. A * marks slightly stale data.</p></div>
  </div>
  <div class="lnote">Every margin is net of the auction price, gas on each transaction we would send, venue fees, our 3 bps markup, and a 10 bps safety buffer. bps = basis points; 100 bps = 1%.</div>
</dialog>
<style>
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}
.controls input,.controls select{background:#141824;color:#E6E9F2;border:1px solid #262C3D;border-radius:6px;padding:6px 8px;font:inherit;font-size:13px}
.controls input{min-width:190px}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{color:#8B9CF0}
.rowk{display:flex;justify-content:space-between;font-size:12px;color:#9AA3B8;margin-top:4px}
.rowk b{color:#E6E9F2}
.rowk.eff{border-top:1px solid #262C3D;margin-top:8px;padding-top:6px}
</style>
<script>
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const chip = c => c ? '<span class="chip ' + c.kind + '">' + esc(c.text) + '</span>' : '';
const usd = n => n === null || n === undefined ? '' : Number(n).toLocaleString('en-US', {maximumFractionDigits: 0});
let activeChain = localStorage.getItem('chain');

function card(v) {
  const pct = v.decided > 0 ? (100 * v.wins / v.decided) : null;
  const seg = (n, cls) => v.decided > 0 && n > 0 ? '<i class="' + cls + '" style="width:' + (100 * n / v.decided) + '%"></i>' : '';
  return '<div class="card"><h3>' + esc(v.name) + '</h3>'
    + '<div class="big">' + (pct === null ? '<span class="mut">no orders</span>' : pct.toFixed(1) + '<small> % won</small>') + '</div>'
    + '<div class="rows">'
    + '<div>won <b>' + v.wins + '</b> of <b>' + v.decided + '</b> priced orders</div>'
    + '<div>typical win <b>' + (v.medianWinBps !== null ? '+' + v.medianWinBps.toFixed(1) + ' bps' : '—') + '</b>'
    + ' · typical miss <b>' + (v.medianMissBps !== null ? v.medianMissBps.toFixed(1) + ' bps' : '—') + '</b></div>'
    // bps mean little without knowing the size they were measured on
    + '<div>typical size <b>' + (v.medianSizeUsd ? usd(v.medianSizeUsd) + ' USD' : '—') + '</b>'
    + ' · total <b>' + (v.totalSizeUsd ? usd(v.totalSizeUsd) + ' USD' : '—') + '</b></div>'
    + '</div>'
    + '<div class="ratio">' + seg(v.wins, 'w') + seg(v.losses, 'l') + seg(v.thin, 't') + '</div>'
    + '</div>';
}

function table(headers, rows) {
  if (!rows.length) return '<div class="empty">nothing yet</div>';
  return '<table><thead><tr>' + headers.map(h => '<th class="' + (h.startsWith('$') ? 'num' : '') + '">' + esc(h.replace('$','')) + '</th>').join('')
    + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
}
const row = cells => '<tr>' + cells.map(c => '<td class="' + (c && c.num ? 'num' : '') + '">' + (c && c.h !== undefined ? c.h : esc(c)) + '</td>').join('') + '</tr>';

function pct(v) { return v === null || v === undefined ? '—' : v.toFixed(0) + '%'; }
function bps(v) { return v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + ' bps'; }

function solverCard(v) {
  var cls = v.winRatePct === null ? 'mut' : v.winRatePct >= 50 ? 'win' : '';
  return '<div class="card">'
    + '<h3>' + esc(v.name) + '</h3>'
    + '<div class="big ' + cls + '">' + pct(v.winRatePct) + '</div>'
    + '<div class="sub">would have won ' + v.wins + ' of ' + v.bids + ' bids</div>'
    + '<div class="rowk"><span>quote held</span><b>' + pct(v.heldPct) + '</b></div>'
    + '<div class="rowk"><span>held when we lost</span><b>' + pct(v.heldPctLost) + '</b></div>'
    + '<div class="rowk"><span>median margin</span><b>' + bps(v.medianMarginBps) + '</b></div>'
    + '<div class="rowk"><span>median slippage</span><b>' + bps(v.medianSlippageBps) + '</b></div>'
    // Winning an auction you cannot honour is not a win, so the two rates are
    // shown multiplied as well as separately.
    + '<div class="rowk eff"><span>effective</span><b>'
    + (v.winRatePct === null || v.heldPct === null ? '—' : (v.winRatePct * v.heldPct / 100).toFixed(0) + '%')
    + '</b></div>'
    + '</div>';
}

function solverSection(c) {
  var s = c.solver;
  var h = '<div class="eyebrow">If we had bid as a solver, sourcing from…</div>';
  h += '<div class="cards">' + s.venues.map(solverCard).join('') + '</div>';
  h += '<div class="funnel">'
    + '<div class="stat"><b>' + s.coverage.tracked + '</b><span>orders tracked</span></div><span class="arrow">&rsaquo;</span>'
    + '<div class="stat"><b>' + s.coverage.bid + '</b><span>bid on</span></div><span class="arrow">&rsaquo;</span>'
    + '<div class="stat"><b>' + s.coverage.resolved + '</b><span>auctions resolved</span></div>'
    + '</div>';

  h += '<h4>Bids — quoted before the winner was known, then re-quoted after</h4>';
  h += '<p class="mut" style="font-size:12px;margin:0 0 4px">Margin is against the best price any rival offered on <em>this</em> order — not the winning solution\u2019s total, which covers its whole bundle. "rivals" counts solvers that bid on this order; "solvers" counts every solution in the batch.</p>';
  h += '<div class="controls">'
    + '<input id="fq" placeholder="filter: pair, venue…" oninput="applyFilters()">'
    + '<select id="fv" onchange="applyFilters()"><option value="">all venues</option>'
    + '<option value="kalqix">KalqiX</option><option value="kyber">Kyber</option><option value="bebop">Bebop</option></select>'
    + '<select id="fr" onchange="applyFilters()"><option value="">won and lost</option>'
    + '<option value="won">won only</option><option value="lost">lost only</option></select>'
    + '<select id="fh" onchange="applyFilters()"><option value="">any hold result</option>'
    + '<option value="held">quote held</option><option value="slipped">quote slipped</option></select>'
    + '<span class="mut" id="fcount"></span></div>';

  var headers = ['ended', 'pair', '$size USD', 'venue', 'result', '$margin', '$slippage', 'held', '$quotes', '$lead s', '$rivals', '$solvers'];
  h += '<table id="solvertbl"><thead><tr>' + headers.map(function (t, i) {
    var num = t.charAt(0) === '$';
    return '<th class="sortable' + (num ? ' num' : '') + '" onclick="sortSolver(' + i + ')">' + esc(t.replace('$', '')) + '<span class="ind"></span></th>';
  }).join('') + '</tr></thead><tbody>' + s.rows.map(solverRow).join('') + '</tbody></table>';
  return h;
}

function solverRow(o) {
  var res = o.noBid
    ? '<span class="chip">no viable bid</span>'
    : o.won
      ? '<span class="chip win">would have won</span>'
      : '<span class="chip">outbid</span>';
  var held = o.held === null ? '<span class="mut">—</span>'
    : o.held ? '<span class="chip win">held</span>' : '<span class="chip short">slipped</span>';
  return '<tr'
    + ' data-venue="' + esc(o.venue || '') + '"'
    + ' data-won="' + (o.won ? 'won' : 'lost') + '"'
    + ' data-held="' + (o.held === null ? '' : o.held ? 'held' : 'slipped') + '"'
    + ' data-text="' + esc(((o.pair || '') + ' ' + (o.venue || '')).toLowerCase()) + '">'
    + '<td>' + esc(o.time) + '</td>'
    + '<td>' + esc(o.pair || '') + '</td>'
    + '<td class="num" data-v="' + (o.sizeUsd === null ? -1 : o.sizeUsd) + '">' + esc(usd(o.sizeUsd)) + '</td>'
    + '<td>' + esc(o.venue || '') + '</td>'
    + '<td>' + res + '</td>'
    + '<td class="num" data-v="' + (o.marginBps === null ? -1e9 : o.marginBps) + '">'
    + (o.noBid ? '<span class="mut">—</span>' : bps(o.marginBps)) + '</td>'
    + '<td class="num" data-v="' + (o.slippageBps === null ? -1e9 : o.slippageBps) + '">' + bps(o.slippageBps) + '</td>'
    + '<td>' + held + '</td>'
    + '<td class="num" data-v="' + o.quoteRounds + '">' + o.quoteRounds + '</td>'
    + '<td class="num" data-v="' + (o.bidLeadMs === null ? -1 : o.bidLeadMs) + '">' + (o.bidLeadMs === null ? '—' : (o.bidLeadMs / 1000).toFixed(0)) + '</td>'
    + '<td class="num" data-v="' + (o.rivalCount === null ? -1 : o.rivalCount) + '">' + (o.rivalCount === null ? '—' : o.rivalCount) + '</td>'
    + '<td class="num" data-v="' + (o.solverCount === null ? -1 : o.solverCount) + '">' + (o.solverCount === null ? '—' : o.solverCount) + '</td>'
    + '</tr>';
}

var sortState = { col: -1, dir: -1 };
function sortSolver(col) {
  var tbl = document.getElementById('solvertbl');
  if (!tbl) return;
  sortState.dir = sortState.col === col ? -sortState.dir : -1;
  sortState.col = col;
  var body = tbl.tBodies[0];
  var rows = [].slice.call(body.rows);
  rows.sort(function (a, b) {
    var x = a.cells[col], y = b.cells[col];
    // Numeric columns carry data-v so that "—" and "+12.3 bps" still order
    // sensibly instead of sorting as text.
    var xv = x.hasAttribute('data-v') ? parseFloat(x.getAttribute('data-v')) : x.textContent.trim();
    var yv = y.hasAttribute('data-v') ? parseFloat(y.getAttribute('data-v')) : y.textContent.trim();
    if (xv < yv) return sortState.dir;
    if (xv > yv) return -sortState.dir;
    return 0;
  });
  rows.forEach(function (r) { body.appendChild(r); });
  var ths = tbl.tHead.rows[0].cells;
  for (var i = 0; i < ths.length; i++) {
    var ind = ths[i].querySelector('.ind');
    if (ind) ind.textContent = i === col ? (sortState.dir === -1 ? ' \u25be' : ' \u25b4') : '';
  }
}

function applyFilters() {
  var q = (document.getElementById('fq') || {}).value || '';
  var v = (document.getElementById('fv') || {}).value || '';
  var r = (document.getElementById('fr') || {}).value || '';
  var hd = (document.getElementById('fh') || {}).value || '';
  var tbl = document.getElementById('solvertbl');
  if (!tbl) return;
  var rows = tbl.tBodies[0].rows, shown = 0;
  q = q.toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var ok = (!q || row.getAttribute('data-text').indexOf(q) >= 0)
      && (!v || row.getAttribute('data-venue') === v)
      && (!r || row.getAttribute('data-won') === r)
      && (!hd || row.getAttribute('data-held') === hd);
    row.style.display = ok ? '' : 'none';
    if (ok) shown++;
  }
  var c = document.getElementById('fcount');
  if (c) c.textContent = shown + ' of ' + rows.length + ' shown';
}

function chainSection(c, active) {
  let h = '<section class="chain' + (active ? ' active' : '') + '" data-chain="' + esc(c.key) + '">';
  h += '<div class="chainmeta">' + c.observedHours.toFixed(1) + ' hours observed · '
    + c.ordersSeen.toLocaleString('en-US') + ' auctions seen · chain ' + c.chainId + '</div>';

  if (c.orderSource === 'cow-solver' && c.solver) {
    h += solverSection(c);
    h += '</section>';
    return h;
  }

  h += '<div class="eyebrow">If we had been a resolver, hedging on…</div>';
  h += '<div class="cards">' + c.venues.map(card).join('') + '</div>';

  h += '<div class="funnel">'
    + '<div class="stat"><b>' + c.funnel.seen.toLocaleString('en-US') + '</b><span>auctions seen</span></div><span class="arrow">&rsaquo;</span>'
    + '<div class="stat"><b>' + c.funnel.hedgeable + '</b><span>hedgeable</span><span class="usd">' + usd(c.funnel.hedgeableUsd) + ' USD</span></div><span class="arrow">&rsaquo;</span>'
    + '<div class="stat"><b>' + c.funnel.priced + '</b><span>priced live</span></div><span class="arrow">&rsaquo;</span>'
    + '<div class="stat"><b>' + c.funnel.won + '</b><span>winnable on some venue</span><span class="usd">' + usd(c.funnel.wonUsd) + ' USD</span></div>'
    + '</div>';

  // A settlement-driven dataset has no live phase — the trade is already done
  // when we see it — so the panel is omitted rather than shown empty.
  if (c.orderSource !== 'cow') {
  h += '<h4>Auctions being priced right now</h4>';
  h += table(['pair', '$size USD', 'auction', 'KalqiX', 'Kyber', 'Bebop', 'expires'],
    c.live.map(o => row([
      o.pair,
      {num: true, h: esc(usd(o.sizeUsd))},
      {h: '<span class="decay"><span class="bar"><i style="width:' + o.decayPct + '%"></i></span><span>' + esc(o.decayLabel) + '</span></span>'},
      {h: chip(o.kalqix)}, {h: chip(o.kyber)}, {h: chip(o.bebop)},
      o.expires
    ])));
  }

  h += c.orderSource === 'cow'
    ? '<h4>Recently settled CoW trades — would another venue have paid more?</h4>'
    : '<h4>Recently decided auctions — would we have won?</h4>';
  h += table(['ended', 'pair', '$size USD', 'result', 'KalqiX', 'Kyber', 'Bebop', 'our head start'],
    c.decided.map(o => row([
      o.time, o.pair,
      {num: true, h: esc(usd(o.sizeUsd))},
      {h: '<span class="mut">' + esc(o.outcome) + '</span>'},
      {h: chip(o.kalqix)}, {h: chip(o.kyber)}, {h: chip(o.bebop)},
      o.lead
    ])));

  h += '<details><summary>Operations detail</summary><div>';
  h += '<div class="kv">' + c.ops.counters.map(x => '<span>' + esc(x[0]) + ' <b>' + esc(x[1]) + '</b></span>').join('') + '</div>';
  h += table(['market', 'mid', 'age', 'bid depth', 'ask depth'], c.ops.books.map(b => row([b.ticker, {num:true,h:esc(b.mid ?? '?')}, b.age, {num:true,h:esc(b.bid ?? '')}, {num:true,h:esc(b.ask ?? '')}])));
  h += table(['most seen unsupported tokens', '$orders'], c.ops.topUnsupported.map(t => row([t.token, {num:true,h:String(t.orders)}])));
  h += table(['time', 'event', 'detail'], c.ops.events.map(e => row([e.time, e.kind, {h:'<span class="mut">' + esc(e.detail) + '</span>'}])));
  h += '</div></details>';

  h += '</section>';
  return h;
}

function setChain(key) {
  activeChain = key;
  localStorage.setItem('chain', key);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.chain === key));
  document.querySelectorAll('.chain').forEach(s => s.classList.toggle('active', s.dataset.chain === key));
  setSubtitle();
}

// The subtitle follows the active dataset: the CoW page measures something
// different from the chain pages, and leaving the Fusion wording there would
// claim a race that never happened.
const SUBTITLES = {
  fusion: 'Watching every 1inch Fusion auction and asking one question: had we been a resolver hedging on '
    + 'KalqiX, Kyber, or Bebop, would filling this order have been profitable before the real winner took it? '
    + 'A measurement only. Nothing is signed or traded.',
  cow: 'Watching every settled CoW Swap trade and asking one question: would KalqiX, Kyber or Bebop have paid '
    + 'that user more than the winning solver did? CoW opens its order book only to its own solvers, so this '
    + 'compares prices after settlement — there is no lead time and no race. A measurement only. Nothing is '
    + 'signed or traded.',
  'cow-solver': 'Simulating what it would take to be a CoW Swap solver. While an order is still open and the '
    + 'winner is unknown, every venue is quoted and the best becomes our bid. When the auction resolves we compare '
    + 'our score with the winning solver’s — then quote the venues again, to see whether the price we bid on was '
    + 'still there once we knew we had to honour it. We never submit a solution, so every win here is '
    + 'counterfactual: our presence would have changed what rivals bid.',
};

let lastChains = [];

function setSubtitle() {
  const active = lastChains.find(c => c.key === activeChain) ?? lastChains[0];
  const el = document.getElementById('sub');
  if (el) el.textContent = SUBTITLES[active && active.orderSource ? active.orderSource : 'fusion'] || SUBTITLES.fusion;
  if (active && active.orderSource === 'cow-solver') applyFilters();
}

async function refresh() {
  try {
    // A dataset-scoped page (/cowswapResolver) asks only for its own data, so
    // the same markup serves both the combined view and a standalone one.
    const scope = window.__DATASET__ ? '?dataset=' + encodeURIComponent(window.__DATASET__) : '';
    const d = await (await fetch('/data.json' + scope)).json();
    document.getElementById('err').textContent = '';
    document.getElementById('stamp').textContent = new Date(d.now).toLocaleTimeString('en-GB') + ' · refreshes every 5s';
    if (!d.chains.some(c => c.key === activeChain)) activeChain = d.chains[0]?.key;

    // preserve open/closed state of the ops drawer across refreshes
    const openDrawers = new Set([...document.querySelectorAll('.chain')].filter(s => s.querySelector('details[open]')).map(s => s.dataset.chain));

    lastChains = d.chains;
    setSubtitle();
    document.getElementById('tabs').style.display = window.__DATASET__ ? 'none' : '';
    document.getElementById('tabs').innerHTML = d.chains.map(c =>
      '<button class="tab' + (c.key === activeChain ? ' active' : '') + '" data-chain="' + esc(c.key) + '" onclick="setChain(\\'' + esc(c.key) + '\\')">'
      + '<span class="dot' + (c.healthy ? '' : ' bad') + '"></span>' + esc(c.label)
      + ' <small>' + c.observedHours.toFixed(0) + 'h</small></button>').join('');

    const root = document.getElementById('root');
    root.innerHTML = d.chains.map(c => chainSection(c, c.key === activeChain)).join('');
    for (const key of openDrawers) {
      const det = document.querySelector('.chain[data-chain="' + key + '"] details');
      if (det) det.setAttribute('open', '');
    }
    root.classList.remove('mut');
  } catch (e) {
    document.getElementById('err').textContent = 'refresh failed: ' + e.message;
  }
}

// close the legend when the backdrop (the dialog element itself) is clicked
document.getElementById('legend').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
if (location.hash === '#legend') document.getElementById('legend').showModal();

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
