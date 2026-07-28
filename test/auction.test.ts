import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuctionCalculator } from '@1inch/fusion-sdk';

// Hand-computed Dutch curve: start t=1000, duration 100s, initial bump 5%
// (500_000 / 10_000_000), one point at +50s dropping to 2.5%, then linear to 0
// at t=1100. Locks in our reading of the SDK's piecewise-linear semantics.
const calc = new AuctionCalculator(1000n, 100n, 500_000n, [{ coefficient: 250_000, delay: 50 }]);

test('rate bump clamps to initial before start and 0 after finish', () => {
  assert.equal(calc.calcRateBump(0n), 500_000);
  assert.equal(calc.calcRateBump(1000n), 500_000);
  assert.equal(calc.calcRateBump(1100n), 0);
  assert.equal(calc.calcRateBump(9999n), 0);
});

test('rate bump interpolates linearly between points', () => {
  assert.equal(calc.calcRateBump(1025n), 375_000); // midway start -> point
  assert.equal(calc.calcRateBump(1050n), 250_000); // at the point
  assert.equal(calc.calcRateBump(1075n), 125_000); // midway point -> finish
});

test('taking amount applies bump over denominator, ceiled', () => {
  // 1e6 at 5% bump: 1e6 * 10.5e6 / 1e7 = 1_050_000 exactly
  assert.equal(calc.calcAuctionTakingAmount(1_000_000n, 500_000), 1_050_000n);
  // non-exact division must ceil: 999_999 * 10_500_000 / 10_000_000 = 1_049_998.95 -> 1_049_999
  assert.equal(calc.calcAuctionTakingAmount(999_999n, 500_000), 1_049_999n);
  // zero bump: unchanged
  assert.equal(calc.calcAuctionTakingAmount(1_000_000n, 0), 1_000_000n);
});

test('monotonic non-increasing cost over the auction', () => {
  let prev = calc.calcRateBump(1000n);
  for (let t = 1001n; t <= 1100n; t++) {
    const cur = calc.calcRateBump(t);
    assert.ok(cur <= prev, `bump increased at t=${t}`);
    prev = cur;
  }
});
