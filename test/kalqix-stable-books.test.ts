import assert from 'node:assert/strict';
import test from 'node:test';
import { rescaleBookDecimals } from '../src/kalqix/sampler.js';
import { walkSellBase } from '../src/kalqix/book.js';
import { toFloat } from '../src/pricing/units.js';
import type { ParsedBook } from '../src/types.js';

/** KalqiX ETH/USDC as it arrives: ETH 18dp, USDC 6dp.
 *  One bid of 10 ETH at 1,900 USDC. */
const ethUsdc: ParsedBook = {
  bids: [{ price: 1_900_000000n, qty: 10n * 10n ** 18n }],
  asks: [{ price: 1_901_000000n, qty: 10n * 10n ** 18n }],
};

test('a USDT pair reads the USDC book unchanged — both are 6dp', () => {
  const b = rescaleBookDecimals(ethUsdc, 18, 6, 18, 6);
  assert.equal(b, ethUsdc, 'identical decimals should not even copy');
});

test('a DAI pair moves the price 12 places, and only the price', () => {
  // DAI is 18dp against USDC's 6dp. ETH is 18dp on both sides, so quantities
  // must NOT move — rescaling both would misprice the book by 10^12.
  const b = rescaleBookDecimals(ethUsdc, 18, 6, 18, 18);
  assert.equal(b.bids[0]!.price, 1_900n * 10n ** 18n);
  assert.equal(b.bids[0]!.qty, 10n * 10n ** 18n, 'ETH quantity is 18dp either way');
});

test('selling 1 ETH yields ~1,900 of the quote asset whichever stable it is', () => {
  const oneEth = 10n ** 18n;

  const usdc = walkSellBase(ethUsdc.bids, oneEth, 18).proceeds!;
  const usdt = walkSellBase(rescaleBookDecimals(ethUsdc, 18, 6, 18, 6).bids, oneEth, 18).proceeds!;
  const dai = walkSellBase(rescaleBookDecimals(ethUsdc, 18, 6, 18, 18).bids, oneEth, 18).proceeds!;

  // The whole point: the same trade must be worth the same money in all three,
  // once each is read at its own decimals.
  assert.equal(toFloat(usdc, 6), 1900);
  assert.equal(toFloat(usdt, 6), 1900);
  assert.equal(toFloat(dai, 18), 1900);
  // The raw integers differ by exactly 10^12, which is the bug this guards.
  assert.equal(dai, usdc * 10n ** 12n);
});

test('a WBTC pair reads the cbBTC book unchanged — 8dp and 6dp on both sides', () => {
  const cbbtc: ParsedBook = {
    bids: [{ price: 65_000_000000n, qty: 2n * 10n ** 8n }],
    asks: [],
  };
  const b = rescaleBookDecimals(cbbtc, 8, 6, 8, 6);
  const proceeds = walkSellBase(b.bids, 10n ** 8n, 8).proceeds!; // sell 1 WBTC
  assert.equal(toFloat(proceeds, 6), 65000);
});

test('a book deeper than the order still fills only what was asked', () => {
  const dai = rescaleBookDecimals(ethUsdc, 18, 6, 18, 18);
  const half = walkSellBase(dai.bids, 5n * 10n ** 17n, 18).proceeds!; // 0.5 ETH
  assert.equal(toFloat(half, 18), 950);
});
