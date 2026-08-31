import assert from 'node:assert/strict';
import test from 'node:test';
import { atFillSize, proRataLimit, scoreOf } from '../src/cow/score.js';

/** A real Arbitrum order that inverted the dashboard.
 *
 *  Sell up to 10,000 EURe for at least 1.0 wstETH — a floor of 0.0001 wstETH
 *  per EURe, partially fillable. Rivals took 1.8% at 0.0004698 per EURe. We
 *  quoted the whole order at 0.0003809 — a worse price — and were shown as
 *  first of six with $8,595 of edge. */
const LIMIT_SELL = 10_000n * 10n ** 18n; // 10,000 EURe
const LIMIT_BUY = 10n ** 18n; // 1.0 wstETH
const FILLED_SELL = 180n * 10n ** 18n; // 1.8% of the order
const RIVAL_BUY = 84_556_143_962_434_366n; // what they delivered for that slice
const OUR_BUY_FULL = 3_809_249_643_335_342_654n; // our quote for the whole order
const PRICE = 10n ** 18n; // 1 native wei per atom, so score == surplus

test('a partial fill only has to clear its share of the floor', () => {
  // 1.8% of the order owes 1.8% of the limit, not all of it.
  const owed = proRataLimit(LIMIT_BUY, FILLED_SELL, LIMIT_SELL);
  assert.equal(owed, 18n * 10n ** 15n); // 0.018 wstETH
  assert.ok(RIVAL_BUY > owed, 'the rival did clear its share');
});

test('judging a partial fill against the whole floor scores it at zero', () => {
  // The bug: 0.0845 against a 1.0 floor reads as a failure, so every partial
  // filler scored nothing and any full-size quote looked unbeatable.
  assert.equal(scoreOf({ ourBuyAmount: RIVAL_BUY, limitBuyAmount: LIMIT_BUY, buyTokenPrice: PRICE }), 0n);
});

test('restated at the same fill size, the rival beats us — as it should', () => {
  const ref = FILLED_SELL;
  const owed = proRataLimit(LIMIT_BUY, ref, LIMIT_SELL);
  const ours = atFillSize(OUR_BUY_FULL, LIMIT_SELL, ref)!;
  const theirs = atFillSize(RIVAL_BUY, FILLED_SELL, ref)!;

  const ourScore = scoreOf({ ourBuyAmount: ours, limitBuyAmount: owed, buyTokenPrice: PRICE })!;
  const theirScore = scoreOf({ ourBuyAmount: theirs, limitBuyAmount: owed, buyTokenPrice: PRICE })!;

  // Their rate is 0.0004698 per EURe against our 0.0003809, so on a like-for-like
  // slice they must come out ahead. Before this, we came out ahead by $8,595.
  assert.ok(theirs > ours, 'the better rate must deliver more at the same size');
  assert.ok(theirScore > ourScore, 'and must therefore score higher');
});

test('scaling to a common size preserves the rate', () => {
  const ref = FILLED_SELL;
  const ours = atFillSize(OUR_BUY_FULL, LIMIT_SELL, ref)!;
  // 1.8% of the order at our full-order rate.
  assert.equal(ours, (OUR_BUY_FULL * ref) / LIMIT_SELL);
  // Linear scaling is conservative: a smaller trade would really get a better
  // rate than this, so it understates us rather than flattering us.
  assert.ok(ours < OUR_BUY_FULL);
});

test('a fully filled order is unaffected by any of this', () => {
  assert.equal(proRataLimit(LIMIT_BUY, LIMIT_SELL, LIMIT_SELL), LIMIT_BUY);
  assert.equal(atFillSize(OUR_BUY_FULL, LIMIT_SELL, LIMIT_SELL), OUR_BUY_FULL);
});

test('a zero-size offer cannot be restated rather than dividing by zero', () => {
  assert.equal(atFillSize(RIVAL_BUY, 0n, FILLED_SELL), null);
  assert.equal(proRataLimit(LIMIT_BUY, FILLED_SELL, 0n), LIMIT_BUY);
});
