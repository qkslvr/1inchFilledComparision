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
<p class="sub">Watching every 1inch Fusion auction and asking one question: had we been a resolver hedging on
KalqiX, Kyber, or Bebop, would filling this order have been profitable before the real winner took it?
A measurement only. Nothing is signed or traded.</p>
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

function chainSection(c, active) {
  let h = '<section class="chain' + (active ? ' active' : '') + '" data-chain="' + esc(c.key) + '">';
  h += '<div class="chainmeta">' + c.observedHours.toFixed(1) + ' hours observed · '
    + c.ordersSeen.toLocaleString('en-US') + ' auctions seen · chain ' + c.chainId + '</div>';

  h += '<div class="eyebrow">If we had been a resolver, hedging on…</div>';
  h += '<div class="cards">' + c.venues.map(card).join('') + '</div>';

  h += '<div class="funnel">'
    + '<div class="stat"><b>' + c.funnel.seen.toLocaleString('en-US') + '</b><span>auctions seen</span></div><span class="arrow">&rsaquo;</span>'
    + '<div class="stat"><b>' + c.funnel.hedgeable + '</b><span>hedgeable</span><span class="usd">' + usd(c.funnel.hedgeableUsd) + ' USD</span></div><span class="arrow">&rsaquo;</span>'
    + '<div class="stat"><b>' + c.funnel.priced + '</b><span>priced live</span></div><span class="arrow">&rsaquo;</span>'
    + '<div class="stat"><b>' + c.funnel.won + '</b><span>winnable on some venue</span><span class="usd">' + usd(c.funnel.wonUsd) + ' USD</span></div>'
    + '</div>';

  h += '<h4>Auctions being priced right now</h4>';
  h += table(['pair', '$size USD', 'auction', 'KalqiX', 'Kyber', 'Bebop', 'expires'],
    c.live.map(o => row([
      o.pair,
      {num: true, h: esc(usd(o.sizeUsd))},
      {h: '<span class="decay"><span class="bar"><i style="width:' + o.decayPct + '%"></i></span><span>' + esc(o.decayLabel) + '</span></span>'},
      {h: chip(o.kalqix)}, {h: chip(o.kyber)}, {h: chip(o.bebop)},
      o.expires
    ])));

  h += '<h4>Recently decided auctions — would we have won?</h4>';
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
