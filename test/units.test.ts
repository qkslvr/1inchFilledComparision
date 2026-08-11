import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bpsOfCeil,
  fmtUnits,
  mulDivCeil,
  mulDivFloor,
  baseForQuoteFloor,
  quoteForBaseCeil,
  quoteForBaseFloor,
  pow10,
  rescale,
} from '../src/pricing/units.js';

test('mulDiv floor and ceil', () => {
  assert.equal(mulDivFloor(10n, 10n, 3n), 33n);
  assert.equal(mulDivCeil(10n, 10n, 3n), 34n);
  assert.equal(mulDivFloor(9n, 1n, 3n), 3n);
  assert.equal(mulDivCeil(9n, 1n, 3n), 3n); // exact division: no bump
});

test('bpsOfCeil', () => {
  assert.equal(bpsOfCeil(10_000n, 10n), 10n); // 10 bps of 10000 = 10
  assert.equal(bpsOfCeil(999n, 10n), 1n); // 0.999 ceils to 1
  assert.equal(bpsOfCeil(10_000n, 0n), 0n);
});

test('quote/base conversions round against us', () => {
  // 1.5 base (8dp) at price 100 quote (6dp) per whole base
  const qty = 15n * pow10(7);
  const price = 100n * pow10(6);
  assert.equal(quoteForBaseFloor(qty, price, 8), 150n * pow10(6));
  assert.equal(quoteForBaseCeil(qty, price, 8), 150n * pow10(6));
  // odd price forces floor < ceil
  const odd = 333_333_333n;
  assert.ok(quoteForBaseFloor(qty, odd, 8) < quoteForBaseCeil(qty, odd, 8));
  // round-trip loses, never gains: base -> quote(floor) -> base(floor) <= base
  const back = baseForQuoteFloor(quoteForBaseFloor(qty, odd, 8), odd, 8);
  assert.ok(back <= qty);
});

test('fmtUnits', () => {
  assert.equal(fmtUnits(1_500_000n, 6), '1.5');
  assert.equal(fmtUnits(1n, 6), '0.000001');
  assert.equal(fmtUnits(-2_000_000n, 6), '-2');
  assert.equal(fmtUnits(123_456_789_012_345_678n, 18), '0.123456');
});

test('rescale normalises stable amounts between chains', () => {
  // 100 USDT on BNB Chain (18dp) -> the 6dp convention notional_usdc uses
  assert.equal(rescale(100n * 10n ** 18n, 18, 6), 100_000_000n);
  // 100 USDC on Ethereum (6dp) is already in that convention
  assert.equal(rescale(100_000_000n, 6, 6), 100_000_000n);
  // and back up, for completeness
  assert.equal(rescale(100_000_000n, 6, 18), 100n * 10n ** 18n);
});
