import assert from 'node:assert/strict';
import test from 'node:test';
import { PAGE } from '../src/dash/page.js';

/** Actually run the page script and render a section.
 *
 *  The syntax test was not enough. A rewrite of the venue card replaced
 *  everything between two function markers, and `overviewCard`, `ov` and
 *  `usdShort` happened to live in that span — so the page still parsed
 *  perfectly and then threw ReferenceError on every render. Both dashboards
 *  went blank while the server cheerfully returned 200 and a full data.json,
 *  which is why it took a while to find.
 *
 *  Parsing proves the file is well-formed. Only calling it proves the functions
 *  it calls exist. */
function evalPage(): Record<string, Function> {
  const script = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .sort((a, b) => b.length - a.length)[0]!;
  const el = () => ({
    innerHTML: '', textContent: '', style: {}, value: '',
    classList: { toggle() {}, add() {} }, dataset: {},
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
    cells: [], rows: [], appendChild() {},
    tBodies: [{ rows: [] as unknown[], appendChild() {} }],
    tHead: { rows: [{ cells: [] as unknown[] }] },
    hasAttribute: () => false, getAttribute: () => '',
  });
  const sandbox = {
    document: { getElementById: () => el(), querySelectorAll: () => [], addEventListener() {}, body: el() },
    localStorage: { getItem: () => null, setItem() {} },
    location: { pathname: '/', search: '', href: 'http://x/' },
    window: {} as Record<string, unknown>,
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: () => Promise.reject(new Error('no network in this test')),
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    `${script}\n return { chainSection, overviewCard, solverSection, solverCard, solverRow };`
  );
  return fn(...Object.values(sandbox)) as Record<string, Function>;
}

/** A dataset with nothing in it — every aggregate null, no rows. The empty case
 *  is the one that breaks, because it is the one nobody looks at. */
const emptyChain = {
  key: 'cicada', label: 'Cicada', chainId: 42161, orderSource: 'cow-solver',
  observedHours: 0, ordersSeen: 0, healthy: false,
  venues: [], funnel: { seen: 0, hedgeable: 0, hedgeableUsd: 0, priced: 0, won: 0, wonUsd: 0 },
  live: [], decided: [],
  ops: { counters: [], books: [], topUnsupported: [], events: [] },
  solver: {
    venues: [
      { venue: 'kyber', name: 'Kyber', bids: 0, wins: 0, noBid: 0, contested: 0, contestedWins: 0,
        contestedWinRatePct: null, winRatePct: null, holdChecks: 0, heldPct: null, heldPctLost: null,
        medianMarginBps: null, medianSlippageBps: null },
    ],
    target: null,
    overview: {
      auctionsSeen: 0, resolved: 0, bidsWon: 0, assetsSeen: 0, observedHours: 0,
      btcPct: null, ethPct: null, stablePct: null, otherPct: null, classified: 0,
      volumeUsd: null, medianSizeUsd: null, heldPct: null, heldWonPct: null,
      medianMarginBps: null, surplusUsd: null, feeUsd: null,
    },
    coverage: { tracked: 0, resolved: 0, bid: 0 },
    rows: [],
  },
};

test('the page script evaluates and exposes its renderers', () => {
  const api = evalPage();
  for (const name of ['chainSection', 'overviewCard', 'solverSection', 'solverCard', 'solverRow']) {
    assert.equal(typeof api[name], 'function', `${name} is not defined in the page script`);
  }
});

test('an empty dataset renders instead of throwing', () => {
  const api = evalPage();
  const html = api.chainSection!(emptyChain, true) as string;
  assert.ok(html.length > 0);
  assert.ok(html.includes('ORDERS TRACKED'), 'the overview strip is missing');
});

test('every table row has exactly as many cells as the header has columns', () => {
  // They drifted apart silently: fifteen headers against eleven cells, so the
  // venue appeared under SIZE and the result under SURPLUS, and every column
  // after the gap was reading the wrong value.
  const api = evalPage();
  const row = api.solverRow!({
    time: '10:00:00', tsMs: 1, pair: 'ETH_USDC', sizeUsd: 1000, venue: 'kyber', won: true,
    noBid: false, marginBps: 12, solverCount: 8, rivalCount: 3, quoteRounds: 4, held: true,
    slippageBps: 1, bidLeadMs: 5000, kind: 'sell', surplusUsd: 1.2, edgeUsd: 0.4, feeUsd: 0.5,
  }) as string;
  const cells = (row.match(/<td/g) ?? []).length;
  const section = api.solverSection!({
    chainId: 1, solver: { venues: [], target: null, rows: [], coverage: { tracked: 0, resolved: 0, bid: 0 },
      overview: { auctionsSeen: 0, resolved: 0, bidsWon: 0, assetsSeen: 0, observedHours: 0, btcPct: null,
        ethPct: null, stablePct: null, otherPct: null, classified: 0, volumeUsd: null, medianSizeUsd: null,
        heldPct: null, heldWonPct: null, medianMarginBps: null, surplusUsd: null, feeUsd: null } },
  }) as string;
  const headerCells = (section.match(/<th class="sortable/g) ?? []).length;
  assert.equal(cells, headerCells, `row emits ${cells} cells for ${headerCells} columns`);
});

test('a populated dataset renders, including the target-solver strip', () => {
  const api = evalPage();
  const withData = {
    ...emptyChain,
    solver: {
      ...emptyChain.solver,
      target: { theyBid: 9, theyWon: 2, theyLost: 7, weBeat: 4, weBeatOnTheirLosses: 3, beatPct: 44.4, medianVsBps: 12, edgeUsd: 41.2 },
      overview: { ...emptyChain.solver.overview, auctionsSeen: 5915, resolved: 287, bidsWon: 42, volumeUsd: 216687772, medianSizeUsd: 10005, heldPct: 78.6, heldWonPct: 72.4, btcPct: 4.6 },
      rows: [{
        time: '10:00:00', tsMs: 1, pair: 'ETH_USDC', sizeUsd: 1000, venue: 'kyber', won: true,
        noBid: false, marginBps: 12, solverCount: 8, rivalCount: 3, quoteRounds: 4, held: true,
        slippageBps: 1, bidLeadMs: 5000, kind: 'sell', surplusUsd: 1.2, edgeUsd: 0.4, feeUsd: 0.5,
      }],
    },
  };
  const html = api.chainSection!(withData, true) as string;
  assert.ok(html.includes('TOTAL VOLUME'), 'volume is missing from the overview');
  assert.ok(html.includes('VS TARGET SOLVER'), 'the target strip is missing');
  assert.ok(html.includes('ETH_USDC'), 'the trade row did not render');
});
