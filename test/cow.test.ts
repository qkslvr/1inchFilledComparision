import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, edgeAt, tickForVenue, DEFAULT_PARAMS } from '../src/report/classify.js';

/** One tick carrying comparable Kyber and CoW quotes.
 *
 *  Both venues return 1,900 USDC of proceeds. Kyber's is gross, so its swap-leg
 *  gas is added to the fill gas; CoW's is already net of its own fee, so only
 *  the fill gas applies. If CoW were charged a swap leg too, it would come out
 *  behind Kyber despite quoting the identical amount. */
const tick = {
  ts_ms: 1000,
  degraded: 0,
  exclusive: 0,
  insufficient_depth: 0,
  hedge_proceeds: null,
  auction_cost: '1800000000',
  gas_cost_raw: '2000000', // fill gas, 2 USDC
  fee_cost: null,
  notional_taker: '1800000000',
  notional_usdc: '1800000000',
  kyber_out: '1900000000',
  kyber_degraded: 0,
  kyber_gas_cost: '3000000', // Kyber's swap leg, 3 USDC
  kyber_fee: '570000',
  cow_out: '1900000000',
  cow_age_ms: 500,
  cow_degraded: 0,
  cow_fee: '570000',
};

test('CoW is charged the fill gas only, Kyber also its swap leg', () => {
  const k = tickForVenue(tick, 'kyber');
  const c = tickForVenue(tick, 'cow');
  assert.equal(k.gasCostRaw, 5_000_000n); // 2 fill + 3 swap
  assert.equal(c.gasCostRaw, 2_000_000n); // fill only
  assert.equal(k.hedgeProceeds, c.hedgeProceeds); // identical quotes
});

test('so an identical quote leaves CoW ahead by exactly the swap gas', () => {
  const k = edgeAt(tickForVenue(tick, 'kyber'), DEFAULT_PARAMS)!;
  const c = edgeAt(tickForVenue(tick, 'cow'), DEFAULT_PARAMS)!;
  assert.equal(c - k, 3_000_000n);
});

test('a tick with no CoW quote yields no CoW edge', () => {
  const t = tickForVenue({ ...tick, cow_out: null, cow_fee: null }, 'cow');
  assert.equal(t.hedgeProceeds, null);
  assert.equal(edgeAt(t, DEFAULT_PARAMS), null);
});

test('a stale CoW quote is degraded, which downgrades a win', () => {
  const order = {
    orderHash: '0x1', eligible: true, skipReason: null,
    terminalStatus: 'expired', tActualMs: null, terminalAtMs: 5000, lateSeen: false,
  };
  const fresh = classify(order, [tickForVenue(tick, 'cow')], DEFAULT_PARAMS);
  const stale = classify(order, [tickForVenue({ ...tick, cow_degraded: 1 }, 'cow')], DEFAULT_PARAMS);
  assert.equal(fresh.cls, 'WIN');
  assert.equal(stale.cls, 'WIN_DEGRADED');
});

test('CoW never reports NO_DEPTH: an aggregate quote either exists or does not', () => {
  const t = tickForVenue({ ...tick, cow_out: null, cow_fee: null }, 'cow');
  assert.equal(t.insufficientDepth, false);
});
