import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreOf, scoreMarginBps, notionalNative, wouldHaveWon } from '../src/cow/score.js';

/** Live mainnet auction 13627568, captured from the public competition feed.
 *  The winner sold 43,250 sUSD against a limit of 42,794,727,884 USDT and
 *  delivered 42,829,499,502 — 34,771,618 atoms of surplus. */
const LIMIT = 42_794_727_884n;
const WINNER_DELIVERED = 42_829_499_502n;
/** USDT's price in that auction's own vector: native wei per atom, 1e18-scaled. */
const USDT_PRICE = 437_730_315_088_261_092_710_727_467n;
const WINNER_REPORTED_SCORE = 15_783_041_052_922_804n;

test('a real winning solution reproduces CoW\'s reported score', () => {
  const s = scoreOf({
    ourBuyAmount: WINNER_DELIVERED,
    limitBuyAmount: LIMIT,
    buyTokenPrice: USDT_PRICE,
  })!;
  // Not exact: the order's protocolFees policy is not yet applied, which is a
  // known open item worth ~3.6%. Pin the gap so it cannot widen unnoticed, and
  // so closing it shows up as a failing test rather than a silent improvement.
  const ratio = Number((s * 10_000n) / WINNER_REPORTED_SCORE) / 10_000;
  assert.ok(ratio > 0.95 && ratio < 1.0, `score ratio ${ratio} left the known 0.95-1.00 band`);
  assert.equal(s, 15_220_591_303_268_650n);
});

test('surplus below the signed limit scores zero, never negative', () => {
  // CoW would refuse such a solution outright, so it is not a worse bid — it is
  // not a bid. Scoring it negative would let it "almost win" in the arithmetic.
  const s = scoreOf({ ourBuyAmount: LIMIT - 1_000n, limitBuyAmount: LIMIT, buyTokenPrice: USDT_PRICE });
  assert.equal(s, 0n);
});

test('exactly meeting the limit is zero surplus', () => {
  assert.equal(scoreOf({ ourBuyAmount: LIMIT, limitBuyAmount: LIMIT, buyTokenPrice: USDT_PRICE }), 0n);
});

test('a token the auction did not price cannot be scored', () => {
  // Falling back to some other price would invent a number and could invent a
  // win with it.
  assert.equal(scoreOf({ ourBuyAmount: WINNER_DELIVERED, limitBuyAmount: LIMIT, buyTokenPrice: undefined }), null);
});

test('beating the winner requires strictly more, not equal', () => {
  assert.equal(wouldHaveWon(100n, 99n), true);
  assert.equal(wouldHaveWon(100n, 100n), false, 'a tie does not win an auction');
  assert.equal(wouldHaveWon(99n, 100n), false);
});

test('an unscoreable bid never counts as a win', () => {
  assert.equal(wouldHaveWon(null, 100n), false);
  assert.equal(wouldHaveWon(100n, null), false);
});

test('margin is signed, in bps of the trade value', () => {
  const notional = 1_000_000n;
  assert.equal(scoreMarginBps(11_000n, 10_000n, notional), 10); // 1000 wei of a 1e6 trade
  assert.equal(scoreMarginBps(9_000n, 10_000n, notional), -10);
  assert.equal(scoreMarginBps(10_000n, 10_000n, notional), 0);
});

test('a rival scoring zero does not explode the margin', () => {
  // This is the bug it replaces: against the rival's own score, a zero or
  // near-zero denominator produced +6,185,770,007 bps on the dashboard.
  // Against notional it stays a sane fraction of the trade.
  const notional = 1_000_000n;
  assert.equal(scoreMarginBps(5_000n, 0n, notional), 50);
  // The real row that produced the absurd figure: now ~1% of the trade.
  // 99.9998, not 99 — the integer division used to truncate the fraction away,
  // which also erased every margin smaller than a whole bps.
  assert.equal(scoreMarginBps(253_667_451_959_248n, 410_081_593n, 25_366_745_195_924_800n), 99.9998);
});

test('a zero notional yields no margin rather than a division blow-up', () => {
  assert.equal(scoreMarginBps(10n, 0n, 0n), null);
});

test('notional in native is the trade value the margin is measured against', () => {
  // 1e6 atoms priced at 1e18 (one native wei per atom) is 1e6 native wei.
  assert.equal(notionalNative(1_000_000n, 10n ** 18n), 1_000_000n);
  assert.equal(notionalNative(1_000_000n, undefined), null);
});
