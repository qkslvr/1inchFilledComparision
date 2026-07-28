import pg from 'pg';
import { MIGRATIONS, SCHEMA, schemaFor } from './schema.js';
import { logError } from '../log.js';

const { Pool, types } = pg;

/** int8 -> number. Every BIGINT in this schema is a millisecond timestamp, a row
 *  id or a COUNT, all far below 2^53. Without this pg hands back strings and
 *  arithmetic like `Date.now() - row.ts_ms` silently turns into string
 *  concatenation — the one type difference from better-sqlite3 that would
 *  otherwise be invisible until a report came out wrong. */
types.setTypeParser(20, (v) => Number(v));

/** Writes are queued and flushed in batches this often. The pricing loop fires
 *  every second and its writes are pure telemetry — nothing reads them back
 *  within the tick — so batching keeps the hot path synchronous-looking. */
const FLUSH_MS = 250;
const MAX_BATCH = 400;

function s(v: bigint | null | undefined): string | null {
  return v === null || v === undefined ? null : v.toString();
}

/** Rewrite better-sqlite3's `?` placeholders as pg's `$1..$n`, leaving anything
 *  inside single-quoted SQL literals alone. Lets the report and dashboard keep
 *  their query strings verbatim. */
export function toPg(sql: string): string {
  let out = '';
  let n = 0;
  let inLiteral = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") {
      inLiteral = !inLiteral;
      out += c;
    } else if (c === '?' && !inLiteral) {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  return out;
}

function sslFor(url: string): pg.ConnectionConfig['ssl'] {
  // Railway's internal network is unencrypted by design; its public proxy needs
  // TLS but presents a cert that doesn't chain to a public root.
  if (/sslmode=disable/.test(url) || /\.railway\.internal/.test(url)) return false;
  return { rejectUnauthorized: false };
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
  sizeUsd: number | null;
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

export interface VenueOutcomeInsert {
  venue: string;
  cls: string;
  marginBps: number | null;
  shortfallBps: number | null;
  hasData: boolean;
}

export interface DecidedOutcomeInsert {
  orderHash: string;
  terminalAtMs: number;
  pair: string | null;
  makerAsset: string;
  takerAsset: string;
  sizeUsd: number | null;
  outcome: string;
  leadS: number | null;
  venues: VenueOutcomeInsert[];
}

/** Create the chain's schema and tables. Collector-side only: the Vercel reader
 *  connects with a role that has no DDL rights. */
export async function migrate(connectionString: string, chainId: number): Promise<void> {
  const schema = schemaFor(chainId);
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString), max: 1 });
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(`SET search_path TO ${schema}; ${SCHEMA}`);
    for (const ddl of MIGRATIONS) await pool.query(`SET search_path TO ${schema}; ${ddl}`);
  } finally {
    await pool.end();
  }
}

export class Db {
  private readonly pool: pg.Pool;
  private queue: Array<{ sql: string; values: unknown[] }> = [];
  private tail: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  /** statements dropped after both the batch and the per-statement retry failed */
  writeErrors = 0;

  private constructor(pool: pg.Pool, readonly chainId: number, readonly readonly_: boolean) {
    this.pool = pool;
    if (!readonly_) {
      this.timer = setInterval(() => void this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  /** `max` defaults low on purpose: a serverless reader opens a pool per warm
   *  instance, and Railway Postgres ships without a connection pooler. */
  static async open(
    chainId: number,
    opts: { readonly?: boolean; connectionString?: string; max?: number } = {}
  ): Promise<Db> {
    const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set (env or .env file)');
    }
    const readonly_ = opts.readonly ?? false;
    if (!readonly_) await migrate(connectionString, chainId);
    const pool = new Pool({
      connectionString,
      ssl: sslFor(connectionString),
      max: opts.max ?? (readonly_ ? 2 : 4),
      // every connection lands in this chain's schema, so the queries below stay
      // unqualified exactly as they were against a per-chain SQLite file
      options: `-c search_path=${schemaFor(chainId)}`,
    });
    return new Db(pool, chainId, readonly_);
  }

  // --- write queue ---

  /** Fire-and-forget. Ordering is preserved, so a row is always written after
   *  the row it references. */
  private enqueue(sql: string, values: unknown[]): void {
    if (this.closed) return;
    this.queue.push({ sql: toPg(sql), values });
    if (this.queue.length >= MAX_BATCH) void this.flush();
  }

  /** Drains the queue. Flushes are serialized against each other so batches
   *  commit in the order they were enqueued. */
  flush(): Promise<void> {
    this.tail = this.tail.then(() => this.drain());
    return this.tail;
  }

  private async drain(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of batch) await client.query(item.sql, item.values);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // One bad statement shouldn't cost the whole batch of telemetry, so retry
      // them individually and drop only what actually fails.
      logError(`db batch of ${batch.length} failed, retrying individually`, err);
      for (const item of batch) {
        try {
          await client.query(item.sql, item.values);
        } catch (itemErr) {
          this.writeErrors++;
          logError(`db write dropped: ${item.sql.slice(0, 60)}`, itemErr);
        }
      }
    } finally {
      client.release();
    }
  }

  /** Read (or write-with-result). Flushes queued writes first so a caller never
   *  reads a state that its own pending writes have already moved past. */
  async all<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> {
    await this.flush();
    const r = await this.pool.query(toPg(sql), values);
    return r.rows as T[];
  }

  async get<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, values))[0];
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    this.closed = true;
    await this.pool.end();
  }

  /** No WAL to checkpoint on Postgres; kept so the collector's shutdown path
   *  still has a "make sure everything landed" step. */
  async checkpoint(): Promise<void> {
    await this.flush();
  }

  // --- runs ---

  async startRun(configJson: string, nodeVersion: string, sdkVersion: string): Promise<number> {
    const row = await this.get<{ id: number }>(
      `INSERT INTO runs (started_at_ms, config_json, node_version, sdk_version)
       VALUES (?, ?, ?, ?) RETURNING id`,
      [Date.now(), configJson, nodeVersion, sdkVersion]
    );
    return row!.id;
  }

  setRunSkew(runId: number, skewMs: number): void {
    this.enqueue(`UPDATE runs SET clock_skew_ms = ? WHERE id = ?`, [skewMs, runId]);
  }

  endRun(runId: number, clean: boolean): void {
    this.enqueue(`UPDATE runs SET ended_at_ms = ?, clean_shutdown = ? WHERE id = ?`, [
      Date.now(),
      clean ? 1 : 0,
      runId,
    ]);
  }

  async lastRunEventTs(): Promise<number | null> {
    const row = await this.get<{ ts: number | null }>(`SELECT MAX(ts_ms) AS ts FROM events`);
    return row?.ts ?? null;
  }

  // --- events ---

  event(runId: number, kind: string, detail?: unknown): void {
    this.enqueue(`INSERT INTO events (run_id, ts_ms, kind, detail_json) VALUES (?, ?, ?, ?)`, [
      runId,
      Date.now(),
      kind,
      detail === undefined ? null : JSON.stringify(detail),
    ]);
  }

  // --- orders ---

  async insertOrder(o: OrderInsert): Promise<boolean> {
    const rows = await this.all(
      `INSERT INTO orders (
        order_hash, first_seen_run_id, received_at_ms, source, late_seen,
        maker_asset, taker_asset, making_amount, taking_amount, remaining_maker,
        maker_address, pair, direction, hedge_asset_kind, eligible, kyber_only, skip_reason, size_usd,
        auction_start_ms, auction_duration_s, initial_rate_bump, auction_points_json,
        gas_bump_estimate, gas_price_estimate, allow_partial_fills, allow_multiple_fills,
        deadline_ms, extension_raw, order_struct_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (order_hash) DO NOTHING
      RETURNING 1 AS inserted`,
      [
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
        o.sizeUsd,
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
        o.orderStructJson,
      ]
    );
    return rows.length > 0;
  }

  updateRemaining(orderHash: string, remaining: bigint): void {
    this.enqueue(`UPDATE orders SET remaining_maker = ? WHERE order_hash = ?`, [
      s(remaining),
      orderHash,
    ]);
  }

  setShadow(orderHash: string, tsMs: number, snapshotId: number | null, edge: bigint, degraded: boolean): void {
    this.enqueue(
      `UPDATE orders SET t_shadow_ms = ?, t_shadow_snapshot_id = ?, t_shadow_edge = ?, t_shadow_degraded = ?
       WHERE order_hash = ? AND t_shadow_ms IS NULL`,
      [tsMs, snapshotId, s(edge), degraded ? 1 : 0, orderHash]
    );
  }

  setMaxEdge(orderHash: string, edge: bigint, tsMs: number): void {
    this.enqueue(`UPDATE orders SET max_edge = ?, max_edge_ms = ? WHERE order_hash = ?`, [
      s(edge),
      tsMs,
      orderHash,
    ]);
  }

  setShadowKyber(orderHash: string, tsMs: number, edge: bigint): void {
    this.enqueue(
      `UPDATE orders SET t_shadow_kyber_ms = ?, t_shadow_kyber_edge = ?
       WHERE order_hash = ? AND t_shadow_kyber_ms IS NULL`,
      [tsMs, s(edge), orderHash]
    );
  }

  setMaxEdgeKyber(orderHash: string, edge: bigint): void {
    this.enqueue(`UPDATE orders SET max_edge_kyber = ? WHERE order_hash = ?`, [s(edge), orderHash]);
  }

  setShadowBebop(orderHash: string, tsMs: number, edge: bigint): void {
    this.enqueue(
      `UPDATE orders SET t_shadow_bebop_ms = ?, t_shadow_bebop_edge = ?
       WHERE order_hash = ? AND t_shadow_bebop_ms IS NULL`,
      [tsMs, s(edge), orderHash]
    );
  }

  setMaxEdgeBebop(orderHash: string, edge: bigint): void {
    this.enqueue(`UPDATE orders SET max_edge_bebop = ? WHERE order_hash = ?`, [s(edge), orderHash]);
  }

  setActualWsTime(orderHash: string, tsMs: number): void {
    this.enqueue(
      `UPDATE orders SET t_actual_ws_ms = ? WHERE order_hash = ? AND t_actual_ws_ms IS NULL`,
      [tsMs, orderHash]
    );
  }

  setTerminal(
    orderHash: string,
    status: string,
    statusJson: string | null,
    filledMakerTotal: bigint | null,
    filledTakerTotal: bigint | null
  ): void {
    this.enqueue(
      `UPDATE orders SET terminal_status = ?, terminal_at_ms = ?, status_json = ?,
       filled_maker_total = ?, filled_taker_total = ? WHERE order_hash = ?`,
      [status, Date.now(), statusJson, s(filledMakerTotal), s(filledTakerTotal), orderHash]
    );
  }

  setActualChainTime(orderHash: string, tsMs: number): void {
    this.enqueue(`UPDATE orders SET t_actual_chain_ms = ? WHERE order_hash = ?`, [tsMs, orderHash]);
  }

  /** Inserted as kyber-only, but no quoter slot was free: record it as an
   *  untracked unsupported order instead. */
  demoteKyberOnly(orderHash: string): void {
    this.enqueue(`UPDATE orders SET kyber_only = 0 WHERE order_hash = ?`, [orderHash]);
  }

  markSkipError(orderHash: string, reason: string): void {
    this.enqueue(`UPDATE orders SET eligible = 0, skip_reason = ? WHERE order_hash = ?`, [
      reason,
      orderHash,
    ]);
  }

  async openOrders(): Promise<Record<string, unknown>[]> {
    return this.all(
      `SELECT * FROM orders WHERE terminal_status IS NULL AND (eligible = 1 OR kyber_only = 1)`
    );
  }

  async orderExists(orderHash: string): Promise<boolean> {
    return (await this.get(`SELECT 1 FROM orders WHERE order_hash = ?`, [orderHash])) !== undefined;
  }

  // --- snapshots / ref prices ---

  async insertSnapshot(
    ticker: string,
    tsMs: number,
    fetchMs: number,
    bestBid: bigint | null,
    bestAsk: bigint | null,
    mid: bigint | null,
    bidDepthBase: bigint,
    askDepthBase: bigint,
    levelsGz: Buffer
  ): Promise<number> {
    const row = await this.get<{ id: number }>(
      `INSERT INTO snapshots (ticker, ts_ms, fetch_ms, best_bid, best_ask, mid, bid_depth_base, ask_depth_base, levels_gz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        ticker,
        tsMs,
        fetchMs,
        s(bestBid),
        s(bestAsk),
        s(mid),
        s(bidDepthBase),
        s(askDepthBase),
        levelsGz,
      ]
    );
    return row!.id;
  }

  insertRefPrice(ticker: string, tsMs: number, mid: bigint): void {
    this.enqueue(
      `INSERT INTO ref_prices (ticker, ts_ms, mid) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [ticker, tsMs, s(mid)]
    );
  }

  // --- ticks ---

  insertTick(t: TickInsert): void {
    this.enqueue(
      `INSERT INTO ticks (
        order_hash, ts_ms, snapshot_id, snapshot_age_ms, degraded, exclusive, remaining_maker,
        rate_bump, insufficient_depth, hedge_proceeds, auction_cost, gas_cost_raw,
        base_fee_wei, gas_price_wei, fee_cost, notional_taker, notional_usdc, edge_default,
        partial_best_qty, partial_best_edge,
        kyber_out, kyber_amount_in, kyber_quote_age_ms, kyber_degraded, kyber_gas_cost, kyber_fee, edge_kyber,
        bebop_out, bebop_age_ms, bebop_degraded, bebop_gas_cost, bebop_fee, edge_bebop
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        s(t.edgeBebop),
      ]
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
    this.enqueue(
      `INSERT INTO fills (order_hash, tx_hash, filled_maker_amount, filled_auction_taker_amount, taker_fee_amount)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [orderHash, txHash, filledMakerAmount, filledAuctionTakerAmount, takerFeeAmount]
    );
  }

  setFillBlock(orderHash: string, txHash: string, blockNumber: number, blockTsMs: number): void {
    this.enqueue(
      `UPDATE fills SET block_number = ?, block_ts_ms = ? WHERE order_hash = ? AND tx_hash = ?`,
      [blockNumber, blockTsMs, orderHash, txHash]
    );
  }

  insertGasSample(tsMs: number, gasPriceWei: bigint, baseFeeWei: bigint): void {
    this.enqueue(
      `INSERT INTO gas_samples (ts_ms, gas_price_wei, base_fee_wei) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [tsMs, s(gasPriceWei), s(baseFeeWei)]
    );
  }

  // --- precomputed dashboard state ---

  /** Written once per order, when it reaches a terminal state. Replaces the
   *  SQLite dashboard's in-process outcomeCache, which a serverless reader
   *  cannot keep. */
  upsertDecidedOutcome(o: DecidedOutcomeInsert): void {
    this.enqueue(
      `INSERT INTO decided_outcomes (
         order_hash, terminal_at_ms, pair, maker_asset, taker_asset, size_usd,
         outcome, lead_s, any_win, computed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (order_hash) DO UPDATE SET
         terminal_at_ms = EXCLUDED.terminal_at_ms, pair = EXCLUDED.pair,
         maker_asset = EXCLUDED.maker_asset, taker_asset = EXCLUDED.taker_asset,
         size_usd = EXCLUDED.size_usd, outcome = EXCLUDED.outcome,
         lead_s = EXCLUDED.lead_s, any_win = EXCLUDED.any_win,
         computed_at_ms = EXCLUDED.computed_at_ms`,
      [
        o.orderHash,
        o.terminalAtMs,
        o.pair,
        o.makerAsset,
        o.takerAsset,
        o.sizeUsd,
        o.outcome,
        o.leadS,
        o.venues.some((v) => v.cls === 'WIN') ? 1 : 0,
        Date.now(),
      ]
    );
    for (const v of o.venues) {
      this.enqueue(
        `INSERT INTO decided_venue_outcomes (order_hash, venue, cls, margin_bps, shortfall_bps, has_data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (order_hash, venue) DO UPDATE SET
           cls = EXCLUDED.cls, margin_bps = EXCLUDED.margin_bps,
           shortfall_bps = EXCLUDED.shortfall_bps, has_data = EXCLUDED.has_data`,
        [o.orderHash, v.venue, v.cls, v.marginBps, v.shortfallBps, v.hasData ? 1 : 0]
      );
    }
  }

  upsertToken(address: string, symbol: string | null): void {
    this.enqueue(
      `INSERT INTO tokens (address, symbol, resolved_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET symbol = EXCLUDED.symbol, resolved_at_ms = EXCLUDED.resolved_at_ms`,
      [address.toLowerCase(), symbol, Date.now()]
    );
  }

  async tokens(): Promise<Array<{ address: string; symbol: string | null }>> {
    return this.all(`SELECT address, symbol FROM tokens`);
  }

  /** Assets appearing on orders that have never been through symbol resolution. */
  async unresolvedTokens(limit: number): Promise<string[]> {
    const rows = await this.all<{ asset: string }>(
      `SELECT asset FROM (
         SELECT maker_asset AS asset FROM orders
         UNION SELECT taker_asset FROM orders
       ) AS assets
       WHERE asset NOT IN (SELECT address FROM tokens)
       LIMIT ?`,
      [limit]
    );
    return rows.map((r) => r.asset);
  }
}
