import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDecimal } from '../src/hyperliquid/client.js';
import { walkBuyBase, walkSellBase } from '../src/kalqix/book.js';

/** Hyperliquid returns human decimal strings; our walkers want quote atoms per
 *  WHOLE base and base atoms. Everything here is about that conversion, because
 *  a units error would not throw — it would quietly quote a price off by a
 *  factor of a thousand and win auctions on it. */

test('a decimal string becomes base units without touching a float', () => {
  assert.equal(parseDecimal('2440.2', 6), 2_440_200_000n); // USDC, 6dp
  assert.equal(parseDecimal('0.9', 18), 900_000_000_000_000_000n); // WETH, 18dp
  assert.equal(parseDecimal('1', 6), 1_000_000n);
  assert.equal(parseDecimal('0', 6), 0n);
});

test('more precision than the token has is truncated, not rounded up', () => {
  // Truncating understates what we would receive, which is the safe direction:
  // it can only ever cost us a win we might have had, never invent one.
  assert.equal(parseDecimal('1.9999999', 6), 1_999_999n);
  assert.equal(parseDecimal('0.0000009', 6), 0n);
});

test('fewer decimals than the token needs are padded, not misread', () => {
  // "2440.2" at 18dp is 2440.2e18, not 2440.2 — the classic off-by-1e17.
  assert.equal(parseDecimal('2440.2', 18), 2_440_200_000_000_000_000_000n);
  assert.equal(parseDecimal('5', 18), 5_000_000_000_000_000_000n);
});

test('a book in those units walks to the price the level implies', () => {
  // One WETH sold into a bid of 0.9 @ 2440.2 and then 2 @ 2440.1 should fetch
  // 0.9*2440.2 + 0.1*2440.1 = 2196.18 + 244.01 = 2440.19 USDC.
  const bids = [
    { price: parseDecimal('2440.2', 6), qty: parseDecimal('0.9', 18) },
    { price: parseDecimal('2440.1', 6), qty: parseDecimal('2', 18) },
  ];
  const walk = walkSellBase(bids, parseDecimal('1', 18), 18);
  assert.equal(walk.proceeds, 2_440_190_000n); // 2440.19 USDC
});

test('a size past the twenty visible levels returns no quote, not a guess', () => {
  // Hyperliquid caps the book at twenty levels a side and they exhaust around a
  // few hundred thousand dollars. Extrapolating past that would manufacture
  // depth that is not there, on the one venue we cannot actually settle against.
  const bids = [{ price: parseDecimal('2440.2', 6), qty: parseDecimal('0.9', 18) }];
  const walk = walkSellBase(bids, parseDecimal('100', 18), 18);
  assert.equal(walk.proceeds, null);
  assert.equal(walk.consumed, parseDecimal('0.9', 18));
});

test('buying the base spends quote into the asks', () => {
  const asks = [{ price: parseDecimal('2440.3', 6), qty: parseDecimal('10', 18) }];
  // 2440.3 USDC buys exactly one WETH at that level.
  const walk = walkBuyBase(asks, parseDecimal('2440.3', 6), 18);
  assert.equal(walk.proceeds, parseDecimal('1', 18));
});
