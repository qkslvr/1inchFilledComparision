import { mulDivCeil } from '../pricing/units.js';

export type Venue = 'kalqix' | 'kyber' | 'bebop' | 'pancake';

/** Raw tick row (SQLite column names) -> venue-specific TickData for classify().
 *  KalqiX: book-walk proceeds, venue taker fee, fill gas.
 *  Kyber: aggregator quote out, our markup fee, fill gas + swap-leg gas.
 *  Bebop: streamed-depth walk, our markup fee, fill gas + settlement gas.
 *  A tick with no usable venue data contributes nothing (hedge null, not NO_DEPTH). */
export function tickForVenue(t: Record<string, any>, venue: Venue): TickData {
  const base: TickData = {
    tsMs: t.ts_ms,
    degraded: t.degraded === 1,
    exclusive: t.exclusive === 1,
    insufficientDepth: t.insufficient_depth === 1,
    hedgeProceeds: t.hedge_proceeds === null ? null : BigInt(t.hedge_proceeds),
    auctionCost: BigInt(t.auction_cost),
    gasCostRaw: BigInt(t.gas_cost_raw),
    feeCost: t.fee_cost === null ? null : BigInt(t.fee_cost),
    notionalTaker: BigInt(t.notional_taker),
    notionalUsdc: t.notional_usdc === null ? null : BigInt(t.notional_usdc),
  };
  if (venue === 'kalqix') return base;
  if (venue === 'bebop') {
    const hasData = t.bebop_out !== null && t.bebop_out !== undefined && t.bebop_gas_cost !== null;
    return {
      ...base,
      degraded: t.bebop_degraded === 1,
      // A streamed book that produced no output means the walk ran out of depth,
      // which is a finding ("too big for this venue"), not missing data. The
      // book's own age is what tells us it was there at all.
      insufficientDepth: t.bebop_age_ms !== null && t.bebop_age_ms !== undefined && !hasData,
      hedgeProceeds: hasData ? BigInt(t.bebop_out) : null,
      gasCostRaw: hasData ? BigInt(t.gas_cost_raw) + BigInt(t.bebop_gas_cost) : base.gasCostRaw,
      feeCost: hasData && t.bebop_fee !== null ? BigInt(t.bebop_fee) : null,
    };
  }
  if (venue === 'pancake') {
    const hasQuote = t.pancake_out !== null && t.pancake_out !== undefined && t.pancake_gas_cost !== null;
    return {
      ...base,
      degraded: t.pancake_degraded === 1,
      // Every tier reverting is the venue saying it cannot fill this size, the
      // same finding the Bebop walk reports when it runs out of depth.
      insufficientDepth:
        t.pancake_age_ms !== null && t.pancake_age_ms !== undefined && !hasQuote,
      hedgeProceeds: hasQuote ? BigInt(t.pancake_out) : null,
      gasCostRaw: hasQuote ? BigInt(t.gas_cost_raw) + BigInt(t.pancake_gas_cost) : base.gasCostRaw,
      feeCost: hasQuote && t.pancake_fee !== null ? BigInt(t.pancake_fee) : null,
    };
  }
  const hasQuote = t.kyber_out !== null && t.kyber_out !== undefined && t.kyber_gas_cost !== null;
  return {
    ...base,
    degraded: t.kyber_degraded === 1,
    insufficientDepth: false,
    hedgeProceeds: hasQuote ? BigInt(t.kyber_out) : null,
    gasCostRaw: hasQuote ? BigInt(t.gas_cost_raw) + BigInt(t.kyber_gas_cost) : base.gasCostRaw,
    feeCost: hasQuote && t.kyber_fee !== null ? BigInt(t.kyber_fee) : null,
  };
}

/** Parsed tick row (all amounts bigint, taker-asset units unless noted). */
export interface TickData {
  tsMs: number;
  degraded: boolean;
  exclusive: boolean;
  insufficientDepth: boolean;
  hedgeProceeds: bigint | null;
  auctionCost: bigint;
  gasCostRaw: bigint;
  feeCost: bigint | null;
  notionalTaker: bigint;
  notionalUsdc: bigint | null;
}

export interface OrderData {
  orderHash: string;
  eligible: boolean;
  skipReason: string | null;
  terminalStatus: string | null;
  tActualMs: number | null; // chain-preferred, ws fallback; null if never filled
  terminalAtMs: number | null;
  lateSeen: boolean;
}

export interface ClassifyParams {
  safetyMarginBps: bigint;
  /** gas multiplier as a rational so bigint math stays exact */
  gasMultNum: bigint;
  gasMultDen: bigint;
}

export const DEFAULT_PARAMS: ClassifyParams = {
  safetyMarginBps: 10n,
  gasMultNum: 1n,
  gasMultDen: 1n,
};

export type OrderClass =
  | 'WIN'
  | 'WIN_DEGRADED'
  | 'LOSE_SPEED'
  | 'LOSE_PRICE'
  | 'NO_DEPTH'
  | 'UNFILLABLE'
  | 'NO_TICKS'
  | 'SKIPPED_UNSUPPORTED'
  | 'SKIPPED_ERROR';

export interface ClassifyResult {
  cls: OrderClass;
  tShadowMs: number | null;
  edgeAtShadow: bigint | null;
  /** margin in bps of taker notional at t_shadow (float for stats) */
  marginBps: number | null;
  /** edge at t_shadow converted to USDC 6dp via the tick's own notional ratio */
  edgeUsdc: bigint | null;
  notionalUsdcAtShadow: bigint | null;
  maxEdge: bigint | null;
  /** for LOSE_PRICE: how far below zero the best edge was, in bps of notional */
  shortfallBps: number | null;
  leadTimeMs: number | null; // tActual - tShadow for wins against a real fill
}

/** Fusion terminal states in which the order was never actually fillable. */
const UNFILLABLE = new Set([
  'false-predicate',
  'not-enough-balance-or-allowance',
  'wrong-permit',
  'invalid-signature',
]);

export function edgeAt(t: TickData, p: ClassifyParams): bigint | null {
  if (t.hedgeProceeds === null || t.feeCost === null) return null;
  const gas = mulDivCeil(t.gasCostRaw, p.gasMultNum, p.gasMultDen);
  return (
    t.hedgeProceeds -
    t.auctionCost -
    gas -
    t.feeCost -
    mulDivCeil(t.notionalTaker, p.safetyMarginBps, 10_000n)
  );
}

/** Pure classification of one order from its raw ticks under arbitrary params.
 *  The collector's cached t_shadow is ignored; this is the source of truth.
 *
 *  Conventions:
 *  - t_shadow = first tick with edge > 0 outside an exclusivity window.
 *  - WIN requires t_shadow strictly before the actual fill; for orders that
 *    expired or were cancelled unfilled, t_shadow before the terminal moment
 *    also counts as WIN (nobody beat us; the fill was there for the taking).
 *  - WIN_DEGRADED: the t_shadow tick used a stale (>3s) or missing snapshot.
 *  - NO_DEPTH only when every snapshot-bearing tick lacked full-size depth.
 */
export function classify(order: OrderData, ticks: TickData[], p: ClassifyParams): ClassifyResult {
  const none: ClassifyResult = {
    cls: 'NO_TICKS',
    tShadowMs: null,
    edgeAtShadow: null,
    marginBps: null,
    edgeUsdc: null,
    notionalUsdcAtShadow: null,
    maxEdge: null,
    shortfallBps: null,
    leadTimeMs: null,
  };

  if (!order.eligible) {
    return { ...none, cls: order.skipReason === 'unsupported_pair' ? 'SKIPPED_UNSUPPORTED' : 'SKIPPED_ERROR' };
  }
  if (order.terminalStatus !== null && UNFILLABLE.has(order.terminalStatus)) {
    return { ...none, cls: 'UNFILLABLE' };
  }
  if (ticks.length === 0) return none;

  // Decision horizon: ticks after the fill (or terminal moment) can't create a win.
  const horizonMs = order.tActualMs ?? order.terminalAtMs ?? Number.MAX_SAFE_INTEGER;

  let tShadow: TickData | null = null;
  let maxEdge: bigint | null = null;
  let sawDepth = false;
  let sawComputable = false;

  for (const t of ticks) {
    const e = edgeAt(t, p);
    if (t.hedgeProceeds !== null) sawDepth = true;
    if (e === null) continue;
    sawComputable = true;
    if (t.tsMs < horizonMs && (maxEdge === null || e > maxEdge)) maxEdge = e;
    if (tShadow === null && e > 0n && !t.exclusive && t.tsMs < horizonMs) {
      tShadow = t;
    }
  }

  if (tShadow !== null) {
    const e = edgeAt(tShadow, p)!;
    const marginBps = Number((e * 1_000_000n) / tShadow.notionalTaker) / 100;
    const edgeUsdc =
      tShadow.notionalUsdc !== null ? (e * tShadow.notionalUsdc) / tShadow.notionalTaker : null;
    return {
      cls: tShadow.degraded ? 'WIN_DEGRADED' : 'WIN',
      tShadowMs: tShadow.tsMs,
      edgeAtShadow: e,
      marginBps,
      edgeUsdc,
      notionalUsdcAtShadow: tShadow.notionalUsdc,
      maxEdge,
      shortfallBps: null,
      leadTimeMs: order.tActualMs !== null ? order.tActualMs - tShadow.tsMs : null,
    };
  }

  // No pre-horizon profitability. Was it ever profitable at all (i.e. only too late)?
  let everProfitable = false;
  for (const t of ticks) {
    const e = edgeAt(t, p);
    if (e !== null && e > 0n && !t.exclusive) {
      everProfitable = true;
      break;
    }
  }
  if (everProfitable) {
    return { ...none, cls: 'LOSE_SPEED', maxEdge };
  }

  if (!sawDepth && ticks.some((t) => t.insufficientDepth)) {
    return { ...none, cls: 'NO_DEPTH' };
  }
  if (!sawComputable) return none;

  // LOSE_PRICE: shortfall = |best edge| in bps of that tick's notional
  let shortfallBps: number | null = null;
  if (maxEdge !== null) {
    let bestTick: TickData | null = null;
    for (const t of ticks) {
      if (edgeAt(t, p) === maxEdge && t.tsMs < horizonMs) {
        bestTick = t;
        break;
      }
    }
    if (bestTick) {
      shortfallBps = Number((-maxEdge * 1_000_000n) / bestTick.notionalTaker) / 100;
    }
  }
  return { ...none, cls: 'LOSE_PRICE', maxEdge, shortfallBps };
}
