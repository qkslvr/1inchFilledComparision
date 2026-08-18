import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTrade } from '../src/cow/settlements.js';
import { classify, edgeAt, tickForVenue, DEFAULT_PARAMS } from '../src/report/classify.js';

/** A real mainnet Trade log, trimmed to the fields the decoder reads. */
const pad = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const uid = 'ab'.repeat(56); // CoW uids are 56 bytes
const data =
  '0x' +
  pad(WETH) +
  pad(USDC) +
  pad((10n ** 18n).toString(16)) + // sellAmount: 1 WETH
  pad((1_890_000000n).toString(16)) + // buyAmount: 1890 USDC
  pad((37_000000000000n).toString(16)) + // feeAmount
  pad((0xc0).toString(16)) + // offset to the uid bytes
  pad((56).toString(16)) + // uid length
  uid.padEnd(128, '0');

test('decodes a Trade log into its economic parts', () => {
  const t = decodeTrade({
    topics: ['0xa07a', '0x000000000000000000000000' + 'ff'.repeat(20)],
    data,
    blockNumber: '0x10',
    transactionHash: '0xdead',
  });
  assert.ok(t);
  assert.equal(t!.sellToken, WETH);
  assert.equal(t!.buyToken, USDC);
  assert.equal(t!.sellAmount, 10n ** 18n);
  assert.equal(t!.buyAmount, 1_890_000000n);
  assert.equal(t!.owner, '0x' + 'ff'.repeat(20));
  assert.equal((t!.orderUid.length - 2) / 2, 56);
});

test('a malformed log is rejected rather than half-decoded', () => {
  assert.equal(decodeTrade({ topics: ['0x'], data: '0x1234', blockNumber: '0x1', transactionHash: '0x' }), null);
});

/** buyAmount takes the place of auctionCost: the user was paid 1,890 USDC, so a
 *  venue must beat that plus costs for the solver to have left money behind. */
const tick = (venueOut: string) => ({
  ts_ms: 1000,
  degraded: 0,
  exclusive: 0,
  insufficient_depth: 0,
  hedge_proceeds: null,
  auction_cost: '1890000000', // what the CoW user received
  gas_cost_raw: '2000000',
  fee_cost: null,
  notional_taker: '1890000000',
  notional_usdc: '1890000000',
  kyber_out: venueOut,
  kyber_degraded: 0,
  kyber_gas_cost: '3000000',
  kyber_fee: '567000',
});

test('a venue paying more than the solver shows a positive edge', () => {
  // 1,900 USDC against the 1,890 the user got, less 2+3 gas, 0.567 fee, 1.89 safety
  const e = edgeAt(tickForVenue(tick('1900000000'), 'kyber'), DEFAULT_PARAMS)!;
  assert.equal(e, 1_900_000000n - 1_890_000000n - 5_000000n - 567_000n - 1_890_000n);
  assert.ok(e > 0n);
});

test('a venue paying less than the solver shows a negative edge', () => {
  const e = edgeAt(tickForVenue(tick('1880000000'), 'kyber'), DEFAULT_PARAMS)!;
  assert.ok(e < 0n);
});

test('no lead time is reported, because the order was never seen in flight', () => {
  const order = {
    orderHash: '0x1', eligible: true, skipReason: null,
    terminalStatus: 'filled',
    tActualMs: null,        // deliberately null for CoW
    terminalAtMs: 1001,     // one ms after the tick, so it stays in the horizon
    lateSeen: false,
  };
  const r = classify(order, [tickForVenue(tick('1900000000'), 'kyber')], DEFAULT_PARAMS);
  assert.equal(r.cls, 'WIN');
  assert.equal(r.leadTimeMs, null);
});
