import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  tickForVenue,
  DEFAULT_PARAMS,
  type ClassifyParams,
  type OrderData,
  type TickData,
} from '../src/report/classify.js';

const P = DEFAULT_PARAMS; // 10 bps safety, 1x gas

function order(overrides: Partial<OrderData> = {}): OrderData {
  return {
    orderHash: '0xabc',
    eligible: true,
    skipReason: null,
    terminalStatus: 'filled',
    tActualMs: 10_000,
    terminalAtMs: 10_500,
    lateSeen: false,
    ...overrides,
  };
}

/** Tick with a clean 1_000_000 notional; edge controlled via hedgeProceeds.
 *  At default params: costs = 1_000_000 auction + 100 gas + fee + 1000 safety. */
function tick(tsMs: number, overrides: Partial<TickData> = {}): TickData {
  return {
    tsMs,
    degraded: false,
    exclusive: false,
    insufficientDepth: false,
    hedgeProceeds: 1_010_000n, // fee = ceil(8bps) = 808 -> edge = 1_010_000-1_000_000-100-808-1000 = 8_092
    auctionCost: 1_000_000n,
    gasCostRaw: 100n,
    feeCost: 808n,
    notionalTaker: 1_000_000n,
    notionalUsdc: 2_000_000n, // 2 USDC per 1 unit notional, exercises conversion
    ...overrides,
  };
}

test('WIN: first profitable tick strictly before the fill', () => {
  const r = classify(order(), [tick(5000), tick(6000)], P);
  assert.equal(r.cls, 'WIN');
  assert.equal(r.tShadowMs, 5000);
  assert.equal(r.edgeAtShadow, 8_092n);
  assert.equal(r.leadTimeMs, 5000);
  assert.ok(Math.abs(r.marginBps! - 80.92) < 0.01);
  assert.equal(r.edgeUsdc, 16_184n); // edge * notionalUsdc / notionalTaker
});

test('WIN_DEGRADED when the t_shadow tick used a stale snapshot', () => {
  const r = classify(order(), [tick(5000, { degraded: true })], P);
  assert.equal(r.cls, 'WIN_DEGRADED');
});

test('LOSE_SPEED: profitable only at/after the actual fill', () => {
  const r = classify(order({ tActualMs: 5000 }), [tick(5000), tick(6000)], P);
  assert.equal(r.cls, 'LOSE_SPEED');
});

test('exclusivity window ticks cannot be t_shadow', () => {
  const r = classify(order(), [tick(5000, { exclusive: true }), tick(6000)], P);
  assert.equal(r.cls, 'WIN');
  assert.equal(r.tShadowMs, 6000);
});

test('LOSE_PRICE with shortfall in bps', () => {
  const losing = tick(5000, { hedgeProceeds: 990_000n, feeCost: 792n });
  // edge = 990000 - 1000000 - 100 - 792 - 1000 = -11_892 -> 118.92 bps short
  const r = classify(order(), [losing], P);
  assert.equal(r.cls, 'LOSE_PRICE');
  assert.ok(Math.abs(r.shortfallBps! - 118.92) < 0.01);
});

test('NO_DEPTH only when no tick ever had full-size depth', () => {
  const noDepth = tick(5000, { hedgeProceeds: null, feeCost: null, insufficientDepth: true });
  assert.equal(classify(order(), [noDepth], P).cls, 'NO_DEPTH');
  // one tick with depth (but unprofitable) -> LOSE_PRICE, not NO_DEPTH
  const losing = tick(6000, { hedgeProceeds: 990_000n, feeCost: 792n });
  assert.equal(classify(order(), [noDepth, losing], P).cls, 'LOSE_PRICE');
});

test('UNFILLABLE terminals are segregated', () => {
  const r = classify(order({ terminalStatus: 'false-predicate' }), [tick(5000)], P);
  assert.equal(r.cls, 'UNFILLABLE');
});

test('skipped orders pass through', () => {
  assert.equal(
    classify(order({ eligible: false, skipReason: 'unsupported_pair' }), [], P).cls,
    'SKIPPED_UNSUPPORTED'
  );
  assert.equal(
    classify(order({ eligible: false, skipReason: 'decode_error' }), [], P).cls,
    'SKIPPED_ERROR'
  );
});

test('NO_TICKS when eligible but nothing was priced', () => {
  assert.equal(classify(order(), [], P).cls, 'NO_TICKS');
});

test('expired unfilled with positive edge counts as WIN with no lead time', () => {
  const r = classify(order({ terminalStatus: 'expired', tActualMs: null, terminalAtMs: 8000 }), [tick(5000)], P);
  assert.equal(r.cls, 'WIN');
  assert.equal(r.leadTimeMs, null);
});

test('sensitivity: a thin WIN flips to LOSE_PRICE at 40 bps safety margin', () => {
  // edge at 10 bps = 8_092 > 0; at 40 bps safety = 8_092 - 3000 = 5_092... make it thinner
  const thin = tick(5000, { hedgeProceeds: 1_003_000n, feeCost: 803n });
  // 10 bps: 1_003_000 - 1_000_000 - 100 - 803 - 1000 = 1_097 -> WIN
  // 40 bps: 1_003_000 - 1_000_000 - 100 - 803 - 4000 = -1_903 -> LOSE_PRICE
  const at = (safety: bigint): ClassifyParams => ({ safetyMarginBps: safety, gasMultNum: 1n, gasMultDen: 1n });
  assert.equal(classify(order(), [thin], at(10n)).cls, 'WIN');
  assert.equal(classify(order(), [thin], at(40n)).cls, 'LOSE_PRICE');
});

test('tickForVenue: kyber view swaps hedge/fee/gas and its own degraded flag', () => {
  const raw = {
    ts_ms: 5000,
    degraded: 1, // kalqix book stale...
    exclusive: 0,
    insufficient_depth: 1, // ...and too thin
    hedge_proceeds: null,
    auction_cost: '1000000',
    gas_cost_raw: '100',
    fee_cost: null,
    notional_taker: '1000000',
    notional_usdc: '1000000',
    kyber_out: '1010000', // but kyber quote exists and is fresh
    kyber_degraded: 0,
    kyber_gas_cost: '400',
    kyber_fee: '303',
  };
  const kalqix = tickForVenue(raw, 'kalqix');
  assert.equal(kalqix.hedgeProceeds, null);
  assert.equal(kalqix.degraded, true);

  const kyber = tickForVenue(raw, 'kyber');
  assert.equal(kyber.hedgeProceeds, 1_010_000n);
  assert.equal(kyber.degraded, false);
  assert.equal(kyber.gasCostRaw, 500n); // fill gas + swap gas
  assert.equal(kyber.feeCost, 303n);

  // same order: NO_DEPTH on kalqix, WIN on kyber
  // kyber edge = 1_010_000 - 1_000_000 - 500 - 303 - 1000 = 8_197
  const o = order();
  assert.equal(classify(o, [kalqix], DEFAULT_PARAMS).cls, 'NO_DEPTH');
  const rk = classify(o, [kyber], DEFAULT_PARAMS);
  assert.equal(rk.cls, 'WIN');
  assert.equal(rk.edgeAtShadow, 8_197n);
});

test('tickForVenue: missing kyber quote yields a no-data tick, not NO_DEPTH', () => {
  const raw = {
    ts_ms: 5000,
    degraded: 0,
    exclusive: 0,
    insufficient_depth: 0,
    hedge_proceeds: '1010000',
    auction_cost: '1000000',
    gas_cost_raw: '100',
    fee_cost: '808',
    notional_taker: '1000000',
    notional_usdc: null,
    kyber_out: null,
    kyber_degraded: null,
    kyber_gas_cost: null,
    kyber_fee: null,
  };
  const kyber = tickForVenue(raw, 'kyber');
  assert.equal(kyber.hedgeProceeds, null);
  assert.equal(kyber.insufficientDepth, false);
  assert.equal(classify(order(), [kyber], DEFAULT_PARAMS).cls, 'NO_TICKS');
});

test('sensitivity: gas multiplier shifts the edge', () => {
  // gas-heavy tick: gasCostRaw 5000; edge at 1x = 1_010_000-1_000_000-5000-808-1000 = 3_192
  const gassy = tick(5000, { gasCostRaw: 5000n });
  const withGas = (num: bigint, den: bigint): ClassifyParams => ({
    safetyMarginBps: 10n,
    gasMultNum: num,
    gasMultDen: den,
  });
  assert.equal(classify(order(), [gassy], withGas(1n, 1n)).cls, 'WIN');
  // 2x gas: 3_192 - 5000 = -1_808 -> lose
  assert.equal(classify(order(), [gassy], withGas(2n, 1n)).cls, 'LOSE_PRICE');
  // 0.5x gas: ceil(2500) -> edge 5_692 -> win
  assert.equal(classify(order(), [gassy], withGas(1n, 2n)).cls, 'WIN');
});
