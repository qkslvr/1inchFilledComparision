import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAuctionSnapshot } from '../src/cow/competition.js';
import { scoreOf, scoreMarginBps, wouldHaveWon } from '../src/cow/score.js';

const TARGET = '0x4cdaf5df3afe11f1726b8975a925245ad14e9f3b';
const ORDER = '0x' + 'cc'.repeat(56);
const LIMIT_BUY = 17_953_057_792_146_475n;
const PRICE = 10n ** 18n; // 1 native wei per atom, so score == surplus

/** Shaped after Arbitrum auction 8612775, where the target won at rank 1. */
const payload = {
  auctionId: 8612775,
  auctionStartBlock: 10,
  auctionDeadlineBlock: 13,
  transactionHashes: ['0xtx'],
  auction: { orders: [ORDER], prices: { '0xbuy': PRICE.toString() } },
  solutions: [
    {
      solverAddress: TARGET,
      score: '248884445176333',
      ranking: 1,
      isWinner: true,
      orders: [{ id: ORDER, sellToken: '0xsell', buyToken: '0xbuy', sellAmount: '45000000', buyAmount: '18133678848713622' }],
    },
    {
      solverAddress: '0x20c917fe6f75b160dd4abee30646c6c173403b5c',
      score: '245638681587765',
      ranking: 2,
      isWinner: false,
      orders: [{ id: ORDER, sellToken: '0xsell', buyToken: '0xbuy', sellAmount: '45000000', buyAmount: '18100000000000000' }],
    },
  ],
};

const proposals = () => parseAuctionSnapshot(payload)!.proposalsByOrder.get(ORDER)!;
const theirs = () => proposals().find((p) => p.solver === TARGET)!;
const scoreFor = (buyAmount: bigint) =>
  scoreOf({ ourBuyAmount: buyAmount, limitBuyAmount: LIMIT_BUY, buyTokenPrice: PRICE })!;

test('the target solver is found among the proposals, with its rank', () => {
  const t = theirs();
  assert.equal(t.ranking, 1);
  assert.equal(t.isWinner, true);
  assert.equal(t.buyAmount, 18_133_678_848_713_622n);
});

test('their surplus is measured against the user limit, same as anyone else', () => {
  // They delivered 18.1337m against a limit of 17.9531m — about 1% of surplus.
  const s = scoreFor(theirs().buyAmount);
  assert.equal(s, 18_133_678_848_713_622n - LIMIT_BUY);
  assert.ok(s > 0n);
});

test('beating them is judged on their bid, not on the auction winner', () => {
  // Here they ARE the winner, so the two coincide — but the comparison must be
  // to their proposal, because on the seven auctions in nine that they lose,
  // the winner is someone else entirely and is not the pitch.
  const ours = scoreFor(18_200_000_000_000_000n);
  assert.equal(wouldHaveWon(ours, scoreFor(theirs().buyAmount)), true);
});

test('matching their price does not beat them', () => {
  const ours = scoreFor(theirs().buyAmount);
  assert.equal(wouldHaveWon(ours, scoreFor(theirs().buyAmount)), false);
});

test('a worse price reports a negative margin against them', () => {
  const ours = scoreFor(18_000_000_000_000_000n);
  const bar = scoreFor(theirs().buyAmount);
  const notional = (LIMIT_BUY * PRICE) / 10n ** 18n;
  const m = scoreMarginBps(ours, bar, notional)!;
  assert.ok(m < 0, `expected a negative margin, got ${m}`);
});

test('an auction the target sat out is distinguishable from one they lost', () => {
  // bid=false must not be recorded as a loss: they never competed, so nothing
  // about their pricing can be inferred from it.
  const without = {
    ...payload,
    solutions: [payload.solutions[1]!],
  };
  const list = parseAuctionSnapshot(without)!.proposalsByOrder.get(ORDER)!;
  assert.equal(list.find((p) => p.solver === TARGET), undefined);
  assert.equal(list.length, 1);
});
