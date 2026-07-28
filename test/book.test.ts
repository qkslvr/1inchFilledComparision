import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkBuyBase, walkSellBase, mid, depthBase } from '../src/kalqix/book.js';
import type { BookLevel } from '../src/types.js';

// Toy asset: base 8dp, quote 6dp (cbBTC/USDC-like numbers kept small for hand math).
const DEC = 8;
const P = (whole: number) => BigInt(Math.round(whole * 1e6)); // quote units per whole base
const Q = (whole: number) => BigInt(Math.round(whole * 1e8)); // base units

test('walkSellBase consumes levels best-first and floors proceeds', () => {
  const bids: BookLevel[] = [
    { price: P(100), qty: Q(1) },
    { price: P(90), qty: Q(2) },
  ];
  // sell 2 base: 1 @ 100 + 1 @ 90 = 190 quote
  const r = walkSellBase(bids, Q(2), DEC);
  assert.equal(r.proceeds, P(190));
  assert.equal(r.consumed, Q(2));
});

test('walkSellBase partial level', () => {
  const bids: BookLevel[] = [{ price: P(100), qty: Q(5) }];
  const r = walkSellBase(bids, Q(1.5), DEC);
  assert.equal(r.proceeds, P(150));
});

test('walkSellBase insufficient depth returns null proceeds and partial consumed', () => {
  const bids: BookLevel[] = [{ price: P(100), qty: Q(1) }];
  const r = walkSellBase(bids, Q(3), DEC);
  assert.equal(r.proceeds, null);
  assert.equal(r.consumed, Q(1));
});

test('walkSellBase floors against us on fractional proceeds', () => {
  // qty 1 base unit (1e-8 base) at price 3 quote units per whole base:
  // exact proceeds = 3 / 1e8 quote units = 0.00000003 -> floors to 0
  const r = walkSellBase([{ price: 3n, qty: 1n }], 1n, DEC);
  assert.equal(r.proceeds, 0n);
});

test('walkBuyBase spends across levels, ceils full-level cost, floors base received', () => {
  const asks: BookLevel[] = [
    { price: P(100), qty: Q(1) }, // full level costs exactly 100 quote
    { price: P(110), qty: Q(2) },
  ];
  // spend 155: 100 buys level 1 fully (1 base), 55 remaining buys 0.5 base at 110
  const r = walkBuyBase(asks, P(155), DEC);
  assert.equal(r.proceeds, Q(1.5));
  assert.equal(r.consumed, P(155));
});

test('walkBuyBase insufficient depth', () => {
  const asks: BookLevel[] = [{ price: P(100), qty: Q(1) }];
  const r = walkBuyBase(asks, P(500), DEC);
  assert.equal(r.proceeds, null);
  assert.equal(r.consumed, P(100)); // only one level's worth of quote could be spent
});

test('walkBuyBase floors dust remainder to zero base', () => {
  // spending 1 quote unit at price 100e6 quote/whole-base: floor(1 * 1e8 / 1e8) ... = 1 base unit
  // use price where it floors to 0: price 3e8, spend 2 -> floor(2 * 1e8 / 3e8) = 0
  const r = walkBuyBase([{ price: 3n * 10n ** 8n, qty: Q(1) }], 2n, DEC);
  assert.equal(r.proceeds, 0n);
  assert.equal(r.consumed, 2n);
});

test('walkBuyBase partial-level base received never exceeds level qty', () => {
  // remaining just below ceiled level cost must not overbuy the level
  const price = 333_333_333n; // odd price to force rounding
  const qty = Q(1);
  const levelCostCeil = (qty * price + 10n ** 8n - 1n) / 10n ** 8n;
  const r = walkBuyBase([{ price, qty }], levelCostCeil - 1n, DEC);
  assert.ok(r.proceeds !== null && r.proceeds <= qty);
});

test('mid and depth', () => {
  const book = {
    bids: [{ price: P(99), qty: Q(2) }],
    asks: [{ price: P(101), qty: Q(3) }],
  };
  assert.equal(mid(book), P(100));
  assert.equal(depthBase(book.bids), Q(2));
  assert.equal(depthBase(book.asks), Q(3));
  assert.equal(mid({ bids: [], asks: book.asks }), null);
});
