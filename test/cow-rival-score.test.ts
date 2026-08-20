import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAuctionSnapshot } from '../src/cow/competition.js';
import { scoreOf, wouldHaveWon } from '../src/cow/score.js';

const OUR_ORDER = '0x' + 'aa'.repeat(56);
const OTHER_ORDER = '0x' + 'bb'.repeat(56);

/** A bundling solver and a single-order solver.
 *
 *  The bundler's solution score is far larger because it covers two orders —
 *  but on OUR order it offers less than the specialist does. Comparing against
 *  its whole-solution score would report us as crushed on an order we win. */
const payload = {
  auctionId: 1,
  auctionStartBlock: 100,
  auctionDeadlineBlock: 103,
  transactionHashes: ['0xtx'],
  auction: { orders: [OUR_ORDER, OTHER_ORDER], prices: { '0xbuy': (10n ** 18n).toString() } },
  solutions: [
    {
      solverAddress: '0xBUNDLER',
      score: '999999999999',
      ranking: 1,
      isWinner: true,
      orders: [
        { id: OUR_ORDER, sellToken: '0xsell', buyToken: '0xbuy', sellAmount: '100', buyAmount: '1010' },
        { id: OTHER_ORDER, sellToken: '0xsell', buyToken: '0xbuy', sellAmount: '900', buyAmount: '9500' },
      ],
    },
    {
      solverAddress: '0xSPECIALIST',
      score: '5000',
      ranking: 2,
      isWinner: false,
      orders: [{ id: OUR_ORDER, sellToken: '0xsell', buyToken: '0xbuy', sellAmount: '100', buyAmount: '1030' }],
    },
  ],
};

const LIMIT = 1000n;
const PRICE = 10n ** 18n; // 1 native wei per atom, so score == surplus

function bestRivalOnOurOrder() {
  const snap = parseAuctionSnapshot(payload)!;
  const proposals = snap.proposalsByOrder.get(OUR_ORDER)!;
  let best: bigint | null = null;
  for (const p of proposals) {
    const s = scoreOf({ ourBuyAmount: p.buyAmount, limitBuyAmount: LIMIT, buyTokenPrice: PRICE })!;
    if (best === null || s > best) best = s;
  }
  return { best, proposals };
}

test('every solution that touched our order is collected, not just the winner', () => {
  const { proposals } = bestRivalOnOurOrder();
  assert.equal(proposals.length, 2);
  assert.deepEqual(
    proposals.map((p) => p.buyAmount).sort((a, b) => (a < b ? -1 : 1)),
    [1010n, 1030n]
  );
});

test('a rival that ignored our order is not counted as a bar for it', () => {
  const snap = parseAuctionSnapshot(payload)!;
  // OTHER_ORDER was only in the bundler's solution.
  assert.equal(snap.proposalsByOrder.get(OTHER_ORDER)!.length, 1);
});

test('the bar is the best price offered on our order, not the biggest solution', () => {
  const { best } = bestRivalOnOurOrder();
  // The specialist's 1030 beats the bundler's 1010 on this order, even though
  // the bundler's whole-solution score is ~200,000x larger.
  assert.equal(best, 30n);
});

test('we win by beating that bar, not the winning solution score', () => {
  const { best } = bestRivalOnOurOrder();
  const ours = scoreOf({ ourBuyAmount: 1040n, limitBuyAmount: LIMIT, buyTokenPrice: PRICE });
  assert.equal(ours, 40n);
  assert.equal(wouldHaveWon(ours, best), true);
  // Against the bundler's whole-solution score of 999,999,999,999 we would have
  // been reported as losing by ~10000 bps — the bug this replaces.
  assert.equal(wouldHaveWon(ours, 999_999_999_999n), false);
});

test('matching the best rival is still a loss', () => {
  const { best } = bestRivalOnOurOrder();
  const ours = scoreOf({ ourBuyAmount: 1030n, limitBuyAmount: LIMIT, buyTokenPrice: PRICE });
  assert.equal(wouldHaveWon(ours, best), false);
});

test('an order nobody else bid on has no bar, so no win is claimed', () => {
  const snap = parseAuctionSnapshot(payload)!;
  assert.equal(snap.proposalsByOrder.get('0xnever'), undefined);
  assert.equal(wouldHaveWon(100n, null), false);
});
