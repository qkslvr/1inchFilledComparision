import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, tickForVenue, DEFAULT_PARAMS } from '../src/report/classify.js';
import { OUTCOME_TICK_SQL } from '../src/report/outcome.js';

/** A tick where Bebop streamed a book but the walk produced nothing — the shape
 *  an order too large for the venue's depth leaves behind. */
const tooBig = {
  ts_ms: 1000,
  degraded: 0,
  exclusive: 0,
  insufficient_depth: 0,
  hedge_proceeds: null,
  auction_cost: '1000',
  gas_cost_raw: '1',
  fee_cost: null,
  notional_taker: '1000',
  notional_usdc: '1000',
  bebop_out: null,
  bebop_age_ms: 120,
  bebop_degraded: 0,
  bebop_gas_cost: null,
  bebop_fee: null,
};

const order = {
  orderHash: '0x1',
  eligible: true,
  skipReason: null,
  terminalStatus: 'expired',
  tActualMs: null,
  terminalAtMs: 5000,
  lateSeen: false,
};

test('a streamed Bebop book that cannot absorb the size is NO_DEPTH, not NO_TICKS', () => {
  const t = tickForVenue(tooBig, 'bebop');
  assert.equal(t.insufficientDepth, true);
  assert.equal(classify(order, [t], DEFAULT_PARAMS).cls, 'NO_DEPTH');
});

test('no streamed book at all stays NO_TICKS', () => {
  const t = tickForVenue({ ...tooBig, bebop_age_ms: null }, 'bebop');
  assert.equal(t.insufficientDepth, false);
  assert.equal(classify(order, [t], DEFAULT_PARAMS).cls, 'NO_TICKS');
});

test('the classifier is fed every bebop column it reads', () => {
  // tickForVenue reading a column the query never selected yields undefined and
  // fails open, which is how the depth case went unnoticed.
  for (const col of ['bebop_out', 'bebop_age_ms', 'bebop_degraded', 'bebop_gas_cost', 'bebop_fee']) {
    assert.ok(OUTCOME_TICK_SQL.includes(col), `OUTCOME_TICK_SQL is missing ${col}`);
  }
});
