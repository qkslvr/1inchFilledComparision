import assert from 'node:assert/strict';
import test from 'node:test';
import { rescaleBook } from '../src/kalqix/sampler.js';
import { walkSellBase } from '../src/kalqix/book.js';
import type { PairConfig } from '../src/types.js';

/** BSC's BTCB/USDT hedging on KalqiX's cbBTC/USDC book: both sides differ. */
const BTCB_USDT: PairConfig = {
  ticker: 'BTCB_USDT',
  base: { symbol: 'BTCB', decimals: 18, addresses: ['0xbtcb'] },
  quote: { symbol: 'USDT', decimals: 18, addresses: ['0xusdt'] },
  kalqix: { ticker: 'cbBTC_USDC', baseDecimals: 8, quoteDecimals: 6 },
};

/** Ethereum's ETH/USDC: decimals already match, so nothing should move. */
const ETH_USDC: PairConfig = {
  ticker: 'ETH_USDC',
  base: { symbol: 'ETH', decimals: 18, addresses: ['0xweth'] },
  quote: { symbol: 'USDC', decimals: 6, addresses: ['0xusdc'] },
  kalqix: { ticker: 'ETH_USDC', baseDecimals: 18, quoteDecimals: 6 },
};

test('a matching market is left untouched', () => {
  const book = { bids: [{ price: 1918_000000n, qty: 10n ** 18n }], asks: [] };
  assert.deepEqual(rescaleBook(book, ETH_USDC), book);
});

test('cbBTC/USDC restated as BTCB/USDT moves both scales', () => {
  // 65,000 USDC per cbBTC (6dp), 0.5 cbBTC of size (8dp)
  const book = { bids: [{ price: 65_000_000000n, qty: 50_000_000n }], asks: [] };
  const out = rescaleBook(book, BTCB_USDT);
  // price becomes 65,000 USDT at 18dp, qty 0.5 BTCB at 18dp
  assert.equal(out.bids[0]!.price, 65_000n * 10n ** 18n);
  assert.equal(out.bids[0]!.qty, 5n * 10n ** 17n);
});

test('walking the restated book gives proceeds in the order’s own units', () => {
  const book = rescaleBook({ bids: [{ price: 65_000_000000n, qty: 50_000_000n }], asks: [] }, BTCB_USDT);
  // sell 0.1 BTCB (18dp) into it
  const walk = walkSellBase(book.bids, 10n ** 17n, BTCB_USDT.base.decimals);
  // 0.1 * 65,000 = 6,500 USDT, expressed at 18dp — not 6dp, and not 10^10 out
  assert.equal(walk.proceeds, 6_500n * 10n ** 18n);
});

test('a pair with no KalqiX market is returned unchanged', () => {
  const bnb: PairConfig = {
    ticker: 'BNB_USDT',
    base: { symbol: 'BNB', decimals: 18, addresses: ['0xwbnb'] },
    quote: { symbol: 'USDT', decimals: 18, addresses: ['0xusdt'] },
  };
  const book = { bids: [{ price: 604n * 10n ** 18n, qty: 10n ** 18n }], asks: [] };
  assert.deepEqual(rescaleBook(book, bnb), book);
});
