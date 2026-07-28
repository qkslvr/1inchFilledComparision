import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA } from './schema.js';

function s(v: bigint | null | undefined): string | null {
  return v === null || v === undefined ? null : v.toString();
}

export interface OrderInsert {
  orderHash: string;
  runId: number;
  receivedAtMs: number;
  source: 'ws' | 'sweep' | 'poll';
  lateSeen: boolean;
  makerAsset: string;
  takerAsset: string;
  makingAmount: bigint;
  takingAmount: bigint;
  remainingMaker: bigint;
  makerAddress: string | null;
  pair: string | null;
  direction: 'SELL_BASE' | 'BUY_BASE' | null;
  hedgeAssetKind: 'native' | 'weth' | 'erc20' | null;
  eligible: boolean;
  kyberOnly: boolean;
  skipReason: string | null;
  auctionStartMs: number | null;
  auctionDurationS: number | null;
  initialRateBump: number | null;
  auctionPointsJson: string | null;
  gasBumpEstimate: bigint | null;
  gasPriceEstimate: bigint | null;
  allowPartialFills: boolean | null;
  allowMultipleFills: boolean | null;
  deadlineMs: number | null;
  extensionRaw: string | null;
  orderStructJson: string | null;
}

export interface TickInsert {
  orderHash: string;
  tsMs: number;
  snapshotId: number | null;
  snapshotAgeMs: number | null;
  degraded: boolean;
  exclusive: boolean;
  remainingMaker: bigint;
  rateBump: number | null;
  insufficientDepth: boolean;
  hedgeProceeds: bigint | null;
  auctionCost: bigint;
  gasCostRaw: bigint;
  baseFeeWei: bigint | null;
  gasPriceWei: bigint | null;
  feeCost: bigint | null;
  notionalTaker: bigint;
  notionalUsdc: bigint | null;
  edgeDefault: bigint | null;
  partialBestQty: bigint | null;
  partialBestEdge: bigint | null;
  kyberOut: bigint | null;
  kyberAmountIn: bigint | null;
  kyberQuoteAgeMs: number | null;
  kyberDegraded: boolean | null;
  kyberGasCost: bigint | null;
  kyberFee: bigint | null;
  edgeKyber: bigint | null;
  bebopOut: bigint | null;
  bebopAgeMs: number | null;
  bebopDegraded: boolean | null;
  bebopGasCost: bigint | null;
  bebopFee: bigint | null;
  edgeBebop: bigint | null;
}

/** Apply pending additive migrations to an existing DB so read-only consumers
 *  (report, dashboard) can SELECT new columns even if the collector writing this
 *  DB hasn't restarted onto the new schema yet. No-op when already current. */
export function ensureMigrated(path: string): void {
  const probe = new Database(path, { readonly: true });
  const missing = MIGRATIONS.filter((m) => {
    const cols = probe.pragma(`table_info(${m.table})`) as Array<{ name: string }>;
    return !cols.some((c) => c.name === m.column);
  });
  probe.close();
  if (missing.length === 0) return;
  const writer = new Database(path);
  writer.pragma('busy_timeout = 5000');
  for (const m of missing) writer.exec(m.ddl);
  writer.close();
}

export class Db {
  readonly raw: Database.Database;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    this.raw = new Database(path, { readonly: opts.readonly ?? false });
    if (!opts.readonly) {
      this.raw.pragma('journal_mode = WAL');
      this.raw.pragma('synchronous = NORMAL');
      this.raw.pragma('foreign_keys = ON');
      this.raw.exec(SCHEMA);
      // additive migrations for DBs created before these columns existed
      for (const m of MIGRATIONS) {
        const cols = this.raw.pragma(`table_info(${m.table})`) as Array<{ name: string }>;
        if (!cols.some((c) => c.name === m.column)) this.raw.exec(m.ddl);
      }
    }
  }

  close(): void {
    this.raw.close();
  }

  checkpoint(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
  }

  // --- runs ---

  startRun(configJson: string, nodeVersion: string, sdkVersion: string): number {
    const r = this.raw
      .prepare(
        `INSERT INTO runs (started_at_ms, config_json, node_version, sdk_version) VALUES (?, ?, ?, ?)`
      )
      .run(Date.now(), configJson, nodeVersion, sdkVersion);
    return Number(r.lastInsertRowid);
  }

  setRunSkew(runId: number, skewMs: number): void {
    this.raw.prepare(`UPDATE runs SET clock_skew_ms = ? WHERE id = ?`).run(skewMs, runId);
  }

  endRun(runId: number, clean: boolean): void {
    this.raw
      .prepare(`UPDATE runs SET ended_at_ms = ?, clean_shutdown = ? WHERE id = ?`)
      .run(Date.now(), clean ? 1 : 0, runId);
  }

  lastRunEventTs(): number | null {
    const row = this.raw.prepare(`SELECT MAX(ts_ms) AS ts FROM events`).get() as { ts: number | null };
    return row.ts;
  }

  // --- events ---

  event(runId: number, kind: string, detail?: unknown): void {
    this.raw
      .prepare(`INSERT INTO events (run_id, ts_ms, kind, detail_json) VALUES (?, ?, ?, ?)`)
      .run(runId, Date.now(), kind, detail === undefined ? null : JSON.stringify(detail));
  }

  // --- orders ---

  insertOrder(o: OrderInsert): boolean {
    const r = this.raw
      .prepare(
        `INSERT OR IGNORE INTO orders (
          order_hash, first_seen_run_id, received_at_ms, source, late_seen,
          maker_asset, taker_asset, making_amount, taking_amount, remaining_maker,
          maker_address, pair, direction, hedge_asset_kind, eligible, kyber_only, skip_reason,
          auction_start_ms, auction_duration_s, initial_rate_bump, auction_points_json,
          gas_bump_estimate, gas_price_estimate, allow_partial_fills, allow_multiple_fills,
          deadline_ms, extension_raw, order_struct_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        o.orderHash,
        o.runId,
        o.receivedAtMs,
        o.source,
        o.lateSeen ? 1 : 0,
        o.makerAsset.toLowerCase(),
        o.takerAsset.toLowerCase(),
        s(o.makingAmount),
        s(o.takingAmount),
        s(o.remainingMaker),
        o.makerAddress?.toLowerCase() ?? null,
        o.pair,
        o.direction,
        o.hedgeAssetKind,
        o.eligible ? 1 : 0,
        o.kyberOnly ? 1 : 0,
        o.skipReason,
        o.auctionStartMs,
        o.auctionDurationS,
        o.initialRateBump,
        o.auctionPointsJson,
        s(o.gasBumpEstimate),
        s(o.gasPriceEstimate),
        o.allowPartialFills === null ? null : o.allowPartialFills ? 1 : 0,
        o.allowMultipleFills === null ? null : o.allowMultipleFills ? 1 : 0,
        o.deadlineMs,
        o.extensionRaw,
        o.orderStructJson
      );
    return r.changes > 0;
  }

  updateRemaining(orderHash: string, remaining: bigint): void {
    this.raw
      .prepare(`UPDATE orders SET remaining_maker = ? WHERE order_hash = ?`)
      .run(s(remaining), orderHash);
  }

  setShadow(orderHash: string, tsMs: number, snapshotId: number | null, edge: bigint, degraded: boolean): void {
    this.raw
      .prepare(
        `UPDATE orders SET t_shadow_ms = ?, t_shadow_snapshot_id = ?, t_shadow_edge = ?, t_shadow_degraded = ?
         WHERE order_hash = ? AND t_shadow_ms IS NULL`
      )
      .run(tsMs, snapshotId, s(edge), degraded ? 1 : 0, orderHash);
  }

  setMaxEdge(orderHash: string, edge: bigint, tsMs: number): void {
    this.raw
      .prepare(`UPDATE orders SET max_edge = ?, max_edge_ms = ? WHERE order_hash = ?`)
      .run(s(edge), tsMs, orderHash);
  }

  setShadowKyber(orderHash: string, tsMs: number, edge: bigint): void {
    this.raw
      .prepare(
        `UPDATE orders SET t_shadow_kyber_ms = ?, t_shadow_kyber_edge = ?
         WHERE order_hash = ? AND t_shadow_kyber_ms IS NULL`
      )
      .run(tsMs, s(edge), orderHash);
  }

  setMaxEdgeKyber(orderHash: string, edge: bigint): void {
    this.raw.prepare(`UPDATE orders SET max_edge_kyber = ? WHERE order_hash = ?`).run(s(edge), orderHash);
  }

  setShadowBebop(orderHash: string, tsMs: number, edge: bigint): void {
    this.raw
      .prepare(
        `UPDATE orders SET t_shadow_bebop_ms = ?, t_shadow_bebop_edge = ?
         WHERE order_hash = ? AND t_shadow_bebop_ms IS NULL`
      )
      .run(tsMs, s(edge), orderHash);
  }

  setMaxEdgeBebop(orderHash: string, edge: bigint): void {
    this.raw.prepare(`UPDATE orders SET max_edge_bebop = ? WHERE order_hash = ?`).run(s(edge), orderHash);
  }

  setActualWsTime(orderHash: string, tsMs: number): void {
    this.raw
      .prepare(`UPDATE orders SET t_actual_ws_ms = ? WHERE order_hash = ? AND t_actual_ws_ms IS NULL`)
      .run(tsMs, orderHash);
  }

  setTerminal(
    orderHash: string,
    status: string,
    statusJson: string | null,
    filledMakerTotal: bigint | null,
    filledTakerTotal: bigint | null
  ): void {
    this.raw
      .prepare(
        `UPDATE orders SET terminal_status = ?, terminal_at_ms = ?, status_json = ?,
         filled_maker_total = ?, filled_taker_total = ? WHERE order_hash = ?`
      )
      .run(status, Date.now(), statusJson, s(filledMakerTotal), s(filledTakerTotal), orderHash);
  }

  setActualChainTime(orderHash: string, tsMs: number): void {
    this.raw
      .prepare(`UPDATE orders SET t_actual_chain_ms = ? WHERE order_hash = ?`)
      .run(tsMs, orderHash);
  }

  markSkipError(orderHash: string, reason: string): void {
    this.raw
      .prepare(`UPDATE orders SET eligible = 0, skip_reason = ? WHERE order_hash = ?`)
      .run(reason, orderHash);
  }

  openOrders(): Record<string, unknown>[] {
    return this.raw
      .prepare(`SELECT * FROM orders WHERE terminal_status IS NULL AND (eligible = 1 OR kyber_only = 1)`)
      .all() as Record<string, unknown>[];
  }

  orderExists(orderHash: string): boolean {
    return (
      this.raw.prepare(`SELECT 1 FROM orders WHERE order_hash = ?`).get(orderHash) !== undefined
    );
  }

  // --- snapshots / ref prices ---

  insertSnapshot(
    ticker: string,
    tsMs: number,
    fetchMs: number,
    bestBid: bigint | null,
    bestAsk: bigint | null,
    mid: bigint | null,
    bidDepthBase: bigint,
    askDepthBase: bigint,
    levelsGz: Buffer
  ): number {
    const r = this.raw
      .prepare(
        `INSERT INTO snapshots (ticker, ts_ms, fetch_ms, best_bid, best_ask, mid, bid_depth_base, ask_depth_base, levels_gz)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(ticker, tsMs, fetchMs, s(bestBid), s(bestAsk), s(mid), s(bidDepthBase), s(askDepthBase), levelsGz);
    return Number(r.lastInsertRowid);
  }

  insertRefPrice(ticker: string, tsMs: number, mid: bigint): void {
    this.raw
      .prepare(`INSERT OR IGNORE INTO ref_prices (ticker, ts_ms, mid) VALUES (?, ?, ?)`)
      .run(ticker, tsMs, s(mid));
  }

  // --- ticks ---

  insertTick(t: TickInsert): void {
    this.raw
      .prepare(
        `INSERT INTO ticks (
          order_hash, ts_ms, snapshot_id, snapshot_age_ms, degraded, exclusive, remaining_maker,
          rate_bump, insufficient_depth, hedge_proceeds, auction_cost, gas_cost_raw,
          base_fee_wei, gas_price_wei, fee_cost, notional_taker, notional_usdc, edge_default,
          partial_best_qty, partial_best_edge,
          kyber_out, kyber_amount_in, kyber_quote_age_ms, kyber_degraded, kyber_gas_cost, kyber_fee, edge_kyber,
          bebop_out, bebop_age_ms, bebop_degraded, bebop_gas_cost, bebop_fee, edge_bebop
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        t.orderHash,
        t.tsMs,
        t.snapshotId,
        t.snapshotAgeMs,
        t.degraded ? 1 : 0,
        t.exclusive ? 1 : 0,
        s(t.remainingMaker),
        t.rateBump,
        t.insufficientDepth ? 1 : 0,
        s(t.hedgeProceeds),
        s(t.auctionCost),
        s(t.gasCostRaw),
        s(t.baseFeeWei),
        s(t.gasPriceWei),
        s(t.feeCost),
        s(t.notionalTaker),
        s(t.notionalUsdc),
        s(t.edgeDefault),
        s(t.partialBestQty),
        s(t.partialBestEdge),
        s(t.kyberOut),
        s(t.kyberAmountIn),
        t.kyberQuoteAgeMs,
        t.kyberDegraded === null ? null : t.kyberDegraded ? 1 : 0,
        s(t.kyberGasCost),
        s(t.kyberFee),
        s(t.edgeKyber),
        s(t.bebopOut),
        t.bebopAgeMs,
        t.bebopDegraded === null ? null : t.bebopDegraded ? 1 : 0,
        s(t.bebopGasCost),
        s(t.bebopFee),
        s(t.edgeBebop)
      );
  }

  // --- fills / gas ---

  upsertFill(
    orderHash: string,
    txHash: string,
    filledMakerAmount: string | null,
    filledAuctionTakerAmount: string | null,
    takerFeeAmount: string | null
  ): void {
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO fills (order_hash, tx_hash, filled_maker_amount, filled_auction_taker_amount, taker_fee_amount)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(orderHash, txHash, filledMakerAmount, filledAuctionTakerAmount, takerFeeAmount);
  }

  setFillBlock(orderHash: string, txHash: string, blockNumber: number, blockTsMs: number): void {
    this.raw
      .prepare(`UPDATE fills SET block_number = ?, block_ts_ms = ? WHERE order_hash = ? AND tx_hash = ?`)
      .run(blockNumber, blockTsMs, orderHash, txHash);
  }

  insertGasSample(tsMs: number, gasPriceWei: bigint, baseFeeWei: bigint): void {
    this.raw
      .prepare(`INSERT OR IGNORE INTO gas_samples (ts_ms, gas_price_wei, base_fee_wei) VALUES (?, ?, ?)`)
      .run(tsMs, s(gasPriceWei), s(baseFeeWei));
  }
}
