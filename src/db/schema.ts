/** Postgres schema. The chain gets its own Postgres *schema* (chain_1), which
 *  reproduces the SQLite build's one-file-per-chain isolation:
 *  every query stays unqualified and unfiltered, the search_path decides which
 *  chain it hits, and the id sequences never collide across chains.
 *
 *  Conventions carried over so the query code above this layer barely changed:
 *    - amounts stay TEXT holding decimal bigints; callers do BigInt(row.x)
 *    - booleans stay 0/1 smallints, so `=== 1` checks and `= 1` predicates hold
 *  Millisecond timestamps are BIGINT; db.ts registers an int8 parser so they
 *  arrive as JS numbers rather than pg's default strings.
 */

/** Postgres schema name for a dataset.
 *
 *  Usually derived from the chain id, but two datasets can share a chain — CoW
 *  settlements and Fusion orders are both Ethereum — so a profile may override
 *  it. That keeps them in separate schemas without a discriminator column on
 *  every table. */
export function schemaFor(chainId: number, override?: string | null): string {
  return override ?? `chain_${chainId}`;
}

/** Additive DDL applied on collector boot. Postgres supports IF NOT EXISTS on
 *  ADD COLUMN, so these are idempotent and need no probing. Empty for a fresh
 *  database: every column the SQLite MIGRATIONS added is in SCHEMA below. */
export const MIGRATIONS: string[] = [
  // PancakeSwap arrived as a fourth venue with BNB Chain; these keep an existing
  // Ethereum database readable by the new code, where the columns stay null.
  `ALTER TABLE ticks ADD COLUMN IF NOT EXISTS pancake_out TEXT`,
  `ALTER TABLE ticks ADD COLUMN IF NOT EXISTS pancake_age_ms INTEGER`,
  `ALTER TABLE ticks ADD COLUMN IF NOT EXISTS pancake_degraded SMALLINT`,
  `ALTER TABLE ticks ADD COLUMN IF NOT EXISTS pancake_gas_cost TEXT`,
  `ALTER TABLE ticks ADD COLUMN IF NOT EXISTS pancake_fee TEXT`,
  `ALTER TABLE ticks ADD COLUMN IF NOT EXISTS pancake_tier INTEGER`,
  `ALTER TABLE ticks ADD COLUMN IF NOT EXISTS edge_pancake TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS t_shadow_pancake_ms BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS t_shadow_pancake_edge TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS max_edge_pancake TEXT`,
  // The CoW dataset gained a live order source (the public solver-competition
  // feed) alongside the settlement-log one. 'auction' means we saw the auction
  // as it was decided; 'chain' means we found it afterwards in a Trade log.
  // Recording which lets the two be reconciled against each other.
  `ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check`,
  `ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('ws','sweep','poll','auction','chain'))`,
  // What we would have had to beat. Scores are wei of native token, stored as
  // TEXT for the same reason every other bigint here is.
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cow_auction_id BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cow_solver_count INTEGER`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cow_winner_solver TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cow_winner_score TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cow_reference_score TEXT`,
  // --- solver simulation ---
  // The order as the user signed it. The competition feed reports what the
  // winner executed, not the limit that had to be beaten, so this comes from
  // /api/v1/orders/{uid} and is what our surplus is measured against.
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS limit_sell_amount TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS limit_buy_amount TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS valid_to_ms BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS partially_fillable SMALLINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_kind TEXT`,
  // Our bid, formed strictly before the auction resolved.
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS our_score TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS our_best_venue TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS our_bid_out TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS bid_at_ms BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS resolved_at_ms BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS won SMALLINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS score_margin_bps DOUBLE PRECISION`,
  `CREATE TABLE IF NOT EXISTS quote_holds (
     order_hash    TEXT NOT NULL REFERENCES orders(order_hash),
     venue         TEXT NOT NULL,
     delay_ms      INTEGER NOT NULL,
     checked_at_ms BIGINT NOT NULL,
     bid_out       TEXT,
     requote_out   TEXT,
     held          SMALLINT,
     slippage_bps  DOUBLE PRECISION,
     PRIMARY KEY (order_hash, venue, delay_ms)
   )`,
  // The bar that actually matters: the best price any rival offered on THIS
  // order, rather than the winner's score for their whole bundle.
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS best_rival_score TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS best_rival_solver TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS rival_count INTEGER`,
  // What the trade is worth in money, rather than in bps of something.
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS surplus_usd DOUBLE PRECISION`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS edge_usd DOUBLE PRECISION`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_usd DOUBLE PRECISION`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS sell_symbol TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS buy_symbol TEXT`,
  `ALTER TABLE quote_holds ADD COLUMN IF NOT EXISTS won SMALLINT`,
  `CREATE INDEX IF NOT EXISTS idx_holds_checked ON quote_holds(checked_at_ms DESC)`,
];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at_ms   BIGINT NOT NULL,
  ended_at_ms     BIGINT,
  clean_shutdown  SMALLINT NOT NULL DEFAULT 0,
  clock_skew_ms   BIGINT,
  config_json     TEXT NOT NULL,
  node_version    TEXT,
  sdk_version     TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  order_hash        TEXT PRIMARY KEY,
  first_seen_run_id BIGINT NOT NULL REFERENCES runs(id),
  received_at_ms    BIGINT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('ws','sweep','poll','auction','chain')),
  late_seen         SMALLINT NOT NULL DEFAULT 0,
  maker_asset       TEXT NOT NULL,
  taker_asset       TEXT NOT NULL,
  making_amount     TEXT NOT NULL,
  taking_amount     TEXT NOT NULL,
  remaining_maker   TEXT NOT NULL,
  maker_address     TEXT,
  pair              TEXT,
  direction         TEXT CHECK (direction IN ('SELL_BASE','BUY_BASE')),
  hedge_asset_kind  TEXT CHECK (hedge_asset_kind IN ('native','weth','erc20')),
  eligible          SMALLINT NOT NULL,
  kyber_only        SMALLINT NOT NULL DEFAULT 0,
  skip_reason       TEXT,
  -- rough USD size at receipt. Stored so the dashboard's funnel is a SUM()
  -- instead of pulling every order row across the wire to price it in JS.
  size_usd          DOUBLE PRECISION,
  auction_start_ms  BIGINT,
  auction_duration_s INTEGER,
  initial_rate_bump INTEGER,
  auction_points_json TEXT,
  gas_bump_estimate TEXT,
  gas_price_estimate TEXT,
  allow_partial_fills SMALLINT,
  allow_multiple_fills SMALLINT,
  deadline_ms       BIGINT,
  extension_raw     TEXT,
  order_struct_json TEXT,
  -- collector-cached shadow state under DEFAULT params; the report recomputes from ticks
  t_shadow_ms          BIGINT,
  t_shadow_snapshot_id BIGINT,
  t_shadow_edge        TEXT,
  t_shadow_degraded    SMALLINT,
  t_shadow_kyber_ms    BIGINT,
  t_shadow_kyber_edge  TEXT,
  max_edge_kyber       TEXT,
  t_shadow_bebop_ms    BIGINT,
  t_shadow_bebop_edge  TEXT,
  max_edge_bebop       TEXT,
  t_shadow_pancake_ms   BIGINT,
  t_shadow_pancake_edge TEXT,
  max_edge_pancake      TEXT,
  max_edge             TEXT,
  max_edge_ms          BIGINT,
  -- outcome
  terminal_status   TEXT,
  terminal_at_ms    BIGINT,
  t_actual_ws_ms    BIGINT,
  t_actual_chain_ms BIGINT,
  filled_maker_total TEXT,
  filled_taker_total TEXT,
  status_json       TEXT,
  -- CoW solver competition, null for the Fusion datasets
  cow_auction_id      BIGINT,
  cow_solver_count    INTEGER,
  cow_winner_solver   TEXT,
  cow_winner_score    TEXT,
  cow_reference_score TEXT,
  -- solver simulation; null for every other dataset
  limit_sell_amount  TEXT,
  limit_buy_amount   TEXT,
  valid_to_ms        BIGINT,
  partially_fillable SMALLINT,
  order_kind         TEXT,
  our_score          TEXT,
  our_best_venue     TEXT,
  our_bid_out        TEXT,
  bid_at_ms          BIGINT,
  resolved_at_ms     BIGINT,
  won                SMALLINT,
  score_margin_bps   DOUBLE PRECISION,
  best_rival_score   TEXT,
  best_rival_solver  TEXT,
  rival_count        INTEGER,
  surplus_usd        DOUBLE PRECISION,
  edge_usd           DOUBLE PRECISION,
  fee_usd            DOUBLE PRECISION,
  sell_symbol        TEXT,
  buy_symbol         TEXT
);

CREATE TABLE IF NOT EXISTS quote_holds (
  order_hash    TEXT NOT NULL REFERENCES orders(order_hash),
  venue         TEXT NOT NULL,
  delay_ms      INTEGER NOT NULL,
  checked_at_ms BIGINT NOT NULL,
  bid_out       TEXT,
  requote_out   TEXT,
  held          SMALLINT,
  slippage_bps  DOUBLE PRECISION,
  -- which arm: a hold rate on won auctions means nothing without the losing
  -- ones to compare it against
  won           SMALLINT,
  PRIMARY KEY (order_hash, venue, delay_ms)
);
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(deadline_ms) WHERE terminal_status IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_pair ON orders(pair);
CREATE INDEX IF NOT EXISTS idx_orders_received ON orders(received_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_orders_terminal ON orders(terminal_at_ms DESC) WHERE terminal_status IS NOT NULL;

CREATE TABLE IF NOT EXISTS fills (
  order_hash TEXT NOT NULL REFERENCES orders(order_hash),
  tx_hash    TEXT NOT NULL,
  filled_maker_amount        TEXT,
  filled_auction_taker_amount TEXT,
  taker_fee_amount           TEXT,
  block_number BIGINT,
  block_ts_ms  BIGINT,
  PRIMARY KEY (order_hash, tx_hash)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id        BIGSERIAL PRIMARY KEY,
  ticker    TEXT NOT NULL,
  ts_ms     BIGINT NOT NULL,
  fetch_ms  INTEGER,
  best_bid  TEXT,
  best_ask  TEXT,
  mid       TEXT,
  bid_depth_base TEXT,
  ask_depth_base TEXT,
  levels_gz BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ticker_ts ON snapshots(ticker, ts_ms);
CREATE INDEX IF NOT EXISTS idx_snapshots_latest ON snapshots(ticker, id DESC);

CREATE TABLE IF NOT EXISTS ref_prices (
  ticker TEXT NOT NULL,
  ts_ms  BIGINT NOT NULL,
  mid    TEXT NOT NULL,
  PRIMARY KEY (ticker, ts_ms)
);

CREATE TABLE IF NOT EXISTS ticks (
  id              BIGSERIAL PRIMARY KEY,
  order_hash      TEXT NOT NULL REFERENCES orders(order_hash),
  ts_ms           BIGINT NOT NULL,
  snapshot_id     BIGINT REFERENCES snapshots(id),
  snapshot_age_ms INTEGER,
  degraded        SMALLINT NOT NULL,
  exclusive       SMALLINT NOT NULL DEFAULT 0,
  remaining_maker TEXT NOT NULL,
  rate_bump       INTEGER,
  insufficient_depth SMALLINT NOT NULL DEFAULT 0,
  hedge_proceeds  TEXT,
  auction_cost    TEXT NOT NULL,
  gas_cost_raw    TEXT NOT NULL,
  base_fee_wei    TEXT,
  gas_price_wei   TEXT,
  fee_cost        TEXT,
  notional_taker  TEXT NOT NULL,
  notional_usdc   TEXT,
  edge_default    TEXT,
  partial_best_qty  TEXT,
  partial_best_edge TEXT,
  kyber_out        TEXT,
  kyber_amount_in  TEXT,
  kyber_quote_age_ms INTEGER,
  kyber_degraded   SMALLINT,
  kyber_gas_cost   TEXT,
  kyber_fee        TEXT,
  edge_kyber       TEXT,
  bebop_out        TEXT,
  bebop_age_ms     INTEGER,
  bebop_degraded   SMALLINT,
  bebop_gas_cost   TEXT,
  bebop_fee        TEXT,
  edge_bebop       TEXT,
  pancake_out      TEXT,
  pancake_age_ms   INTEGER,
  pancake_degraded SMALLINT,
  pancake_gas_cost TEXT,
  pancake_fee      TEXT,
  pancake_tier     INTEGER,
  edge_pancake     TEXT
);
-- One index, not two. order_hash is a 66-character string, so every index on it
-- costs ~100 bytes a row; a second one made the ticks indexes larger than the
-- ticks themselves (194 MB against 191 MB of data). Anything that wanted the
-- latest tick for an order can order by ts_ms here instead of by id.
CREATE INDEX IF NOT EXISTS idx_ticks_order ON ticks(order_hash, ts_ms DESC);
DROP INDEX IF EXISTS idx_ticks_order_id;

CREATE TABLE IF NOT EXISTS gas_samples (
  ts_ms         BIGINT PRIMARY KEY,
  gas_price_wei TEXT,
  base_fee_wei  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id     BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES runs(id),
  ts_ms  BIGINT NOT NULL,
  kind   TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_recent ON events(id DESC);

-- Precomputed terminal-order verdicts. The SQLite dashboard re-classified every
-- order's ticks on demand and leaned on a process-lifetime cache to make that
-- affordable; a serverless reader has no such cache, so the collector writes the
-- verdict once, when the order reaches a terminal state.
CREATE TABLE IF NOT EXISTS decided_outcomes (
  order_hash     TEXT PRIMARY KEY REFERENCES orders(order_hash),
  terminal_at_ms BIGINT NOT NULL,
  pair           TEXT,
  maker_asset    TEXT NOT NULL,
  taker_asset    TEXT NOT NULL,
  size_usd       DOUBLE PRECISION,
  outcome        TEXT NOT NULL,
  lead_s         INTEGER,
  any_win        SMALLINT NOT NULL DEFAULT 0,
  computed_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decided_recent ON decided_outcomes(terminal_at_ms DESC);

-- One row per (order, venue): lets the scoreboard aggregate in SQL instead of
-- pulling every decided order into the reader.
CREATE TABLE IF NOT EXISTS decided_venue_outcomes (
  order_hash    TEXT NOT NULL REFERENCES decided_outcomes(order_hash) ON DELETE CASCADE,
  venue         TEXT NOT NULL,
  cls           TEXT NOT NULL,
  margin_bps    DOUBLE PRECISION,
  shortfall_bps DOUBLE PRECISION,
  has_data      SMALLINT NOT NULL,
  PRIMARY KEY (order_hash, venue)
);
CREATE INDEX IF NOT EXISTS idx_decided_venue ON decided_venue_outcomes(venue, cls);

-- Running totals of what retention has deleted, so headline counts survive the
-- rows they were derived from. Without this, pruning 57k unsupported orders
-- would silently drop "auctions seen" from 58,000 to 265 and misstate how much
-- flow was actually observed.
CREATE TABLE IF NOT EXISTS purged_stats (
  kind          TEXT PRIMARY KEY,
  count         BIGINT NOT NULL DEFAULT 0,
  last_purge_ms BIGINT
);

-- Resolved ERC-20 symbols. The SQLite dashboard cached these in module memory,
-- which a serverless reader loses on every cold start; persisting keeps the
-- unsupported-token table readable instead of a wall of address stubs.
CREATE TABLE IF NOT EXISTS tokens (
  address        TEXT PRIMARY KEY,
  symbol         TEXT,
  resolved_at_ms BIGINT NOT NULL
);
`;
