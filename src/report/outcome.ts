/** Turning a finished order into the stored verdict the dashboard reads.
 *  Shared by the collector (which does this once, as each order finishes) and
 *  the backfill script (which does it for history imported from SQLite), so the
 *  two can't drift. */
import { config } from '../../config.js';
import type { DecidedOutcomeInsert, VenueOutcomeInsert } from '../db/db.js';
import { classify, tickForVenue, type Venue } from './classify.js';
import { toFloat } from '../pricing/units.js';

export const VENUES: Venue[] = ['kalqix', 'kyber', 'bebop'];

/** Columns classify() needs; kept next to the builder that consumes them. */
export const OUTCOME_TICK_SQL = `SELECT ts_ms, degraded, exclusive, insufficient_depth, hedge_proceeds,
  auction_cost, gas_cost_raw, fee_cost, notional_taker, notional_usdc,
  kyber_out, kyber_degraded, kyber_gas_cost, kyber_fee,
  bebop_out, bebop_degraded, bebop_gas_cost, bebop_fee
  FROM ticks WHERE order_hash = ? ORDER BY ts_ms`;

export const OUTCOME_ORDER_SQL = `SELECT order_hash, pair, terminal_status, terminal_at_ms,
  t_actual_ws_ms, t_actual_chain_ms, late_seen, maker_asset, taker_asset, size_usd
  FROM orders WHERE order_hash = ? AND (eligible = 1 OR kyber_only = 1)`;

export function buildDecidedOutcome(
  row: Record<string, any>,
  raw: Record<string, any>[]
): DecidedOutcomeInsert {
  const orderData = {
    orderHash: row.order_hash as string,
    // Callers select only eligible/kyber-only orders, and a kyber-only order is
    // "ineligible" solely for KalqiX — passing eligible:false here would collapse
    // every venue to SKIPPED_UNSUPPORTED.
    eligible: true,
    skipReason: null,
    terminalStatus: row.terminal_status as string,
    tActualMs: (row.t_actual_chain_ms ?? row.t_actual_ws_ms ?? null) as number | null,
    terminalAtMs: row.terminal_at_ms as number | null,
    lateSeen: row.late_seen === 1,
  };
  const params = { safetyMarginBps: config.safetyMarginBps, gasMultNum: 1n, gasMultDen: 1n };

  const venues: VenueOutcomeInsert[] = [];
  let leadS: number | null = null;
  for (const venue of VENUES) {
    const ticks = raw.map((t) => tickForVenue(t, venue));
    const r = classify(orderData, ticks, params);
    venues.push({
      venue,
      cls: r.cls,
      marginBps: r.marginBps,
      shortfallBps: r.shortfallBps,
      hasData: ticks.some((t) => t.hedgeProceeds !== null || t.insufficientDepth),
    });
    if (r.leadTimeMs !== null && r.cls === 'WIN') leadS = Math.round(r.leadTimeMs / 1000);
  }

  // The tick's own USD notional is the better number when we have it: it was
  // measured against the auction price at the moment of the decision, where the
  // order's size_usd is a rough estimate taken at receipt.
  const firstUsd = raw.find((t) => t.notional_usdc !== null);
  const sizeUsd =
    firstUsd !== undefined ? toFloat(BigInt(firstUsd.notional_usdc), 6) : (row.size_usd as number | null);

  return {
    orderHash: row.order_hash as string,
    terminalAtMs: (row.terminal_at_ms as number) ?? Date.now(),
    pair: (row.pair as string | null) ?? null,
    makerAsset: row.maker_asset as string,
    takerAsset: row.taker_asset as string,
    sizeUsd,
    outcome: row.terminal_status as string,
    leadS,
    venues,
  };
}
