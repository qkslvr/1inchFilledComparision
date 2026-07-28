/** Columns added after first release; applied additively so an existing DB
 *  (possibly mid-collection) migrates on open without touching old rows. */
export const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'ticks', column: 'kyber_out', ddl: 'ALTER TABLE ticks ADD COLUMN kyber_out TEXT' },
  { table: 'ticks', column: 'kyber_amount_in', ddl: 'ALTER TABLE ticks ADD COLUMN kyber_amount_in TEXT' },
  { table: 'ticks', column: 'kyber_quote_age_ms', ddl: 'ALTER TABLE ticks ADD COLUMN kyber_quote_age_ms INTEGER' },
  { table: 'ticks', column: 'kyber_degraded', ddl: 'ALTER TABLE ticks ADD COLUMN kyber_degraded INTEGER' },
  { table: 'ticks', column: 'kyber_gas_cost', ddl: 'ALTER TABLE ticks ADD COLUMN kyber_gas_cost TEXT' },
  { table: 'ticks', column: 'kyber_fee', ddl: 'ALTER TABLE ticks ADD COLUMN kyber_fee TEXT' },
  { table: 'ticks', column: 'edge_kyber', ddl: 'ALTER TABLE ticks ADD COLUMN edge_kyber TEXT' },
  { table: 'orders', column: 'kyber_only', ddl: 'ALTER TABLE orders ADD COLUMN kyber_only INTEGER NOT NULL DEFAULT 0' },
  { table: 'ticks', column: 'bebop_out', ddl: 'ALTER TABLE ticks ADD COLUMN bebop_out TEXT' },
  { table: 'ticks', column: 'bebop_age_ms', ddl: 'ALTER TABLE ticks ADD COLUMN bebop_age_ms INTEGER' },
  { table: 'ticks', column: 'bebop_degraded', ddl: 'ALTER TABLE ticks ADD COLUMN bebop_degraded INTEGER' },
  { table: 'ticks', column: 'bebop_gas_cost', ddl: 'ALTER TABLE ticks ADD COLUMN bebop_gas_cost TEXT' },
  { table: 'ticks', column: 'bebop_fee', ddl: 'ALTER TABLE ticks ADD COLUMN bebop_fee TEXT' },
  { table: 'ticks', column: 'edge_bebop', ddl: 'ALTER TABLE ticks ADD COLUMN edge_bebop TEXT' },
  { table: 'orders', column: 't_shadow_bebop_ms', ddl: 'ALTER TABLE orders ADD COLUMN t_shadow_bebop_ms INTEGER' },
  { table: 'orders', column: 't_shadow_bebop_edge', ddl: 'ALTER TABLE orders ADD COLUMN t_shadow_bebop_edge TEXT' },
  { table: 'orders', column: 'max_edge_bebop', ddl: 'ALTER TABLE orders ADD COLUMN max_edge_bebop TEXT' },
  { table: 'orders', column: 't_shadow_kyber_ms', ddl: 'ALTER TABLE orders ADD COLUMN t_shadow_kyber_ms INTEGER' },
  { table: 'orders', column: 't_shadow_kyber_edge', ddl: 'ALTER TABLE orders ADD COLUMN t_shadow_kyber_edge TEXT' },
  { table: 'orders', column: 'max_edge_kyber', ddl: 'ALTER TABLE orders ADD COLUMN max_edge_kyber TEXT' },
];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_ms   INTEGER NOT NULL,
  ended_at_ms     INTEGER,
  clean_shutdown  INTEGER NOT NULL DEFAULT 0,
  clock_skew_ms   INTEGER,
  config_json     TEXT NOT NULL,
  node_version    TEXT,
  sdk_version     TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  order_hash        TEXT PRIMARY KEY,
  first_seen_run_id INTEGER NOT NULL REFERENCES runs(id),
  received_at_ms    INTEGER NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('ws','sweep','poll')),
  late_seen         INTEGER NOT NULL DEFAULT 0,
  maker_asset       TEXT NOT NULL,
  taker_asset       TEXT NOT NULL,
  making_amount     TEXT NOT NULL,
  taking_amount     TEXT NOT NULL,
  remaining_maker   TEXT NOT NULL,
  maker_address     TEXT,
  pair              TEXT,
  direction         TEXT CHECK (direction IN ('SELL_BASE','BUY_BASE')),
  hedge_asset_kind  TEXT CHECK (hedge_asset_kind IN ('native','weth','erc20')),
  eligible          INTEGER NOT NULL,
  kyber_only        INTEGER NOT NULL DEFAULT 0,
  skip_reason       TEXT,
  auction_start_ms  INTEGER,
  auction_duration_s INTEGER,
  initial_rate_bump INTEGER,
  auction_points_json TEXT,
  gas_bump_estimate TEXT,
  gas_price_estimate TEXT,
  allow_partial_fills INTEGER,
  allow_multiple_fills INTEGER,
  deadline_ms       INTEGER,
  extension_raw     TEXT,
  order_struct_json TEXT,
  -- collector-cached shadow state under DEFAULT params; the report recomputes from ticks
  t_shadow_ms          INTEGER,
  t_shadow_snapshot_id INTEGER,
  t_shadow_edge        TEXT,
  t_shadow_degraded    INTEGER,
  t_shadow_kyber_ms    INTEGER,
  t_shadow_kyber_edge  TEXT,
  max_edge_kyber       TEXT,
  t_shadow_bebop_ms    INTEGER,
  t_shadow_bebop_edge  TEXT,
  max_edge_bebop       TEXT,
  max_edge             TEXT,
  max_edge_ms          INTEGER,
  -- outcome
  terminal_status   TEXT,
  terminal_at_ms    INTEGER,
  t_actual_ws_ms    INTEGER,
  t_actual_chain_ms INTEGER,
  filled_maker_total TEXT,
  filled_taker_total TEXT,
  status_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(deadline_ms) WHERE terminal_status IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_pair ON orders(pair);

CREATE TABLE IF NOT EXISTS fills (
  order_hash TEXT NOT NULL REFERENCES orders(order_hash),
  tx_hash    TEXT NOT NULL,
  filled_maker_amount        TEXT,
  filled_auction_taker_amount TEXT,
  taker_fee_amount           TEXT,
  block_number INTEGER,
  block_ts_ms  INTEGER,
  PRIMARY KEY (order_hash, tx_hash)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker    TEXT NOT NULL,
  ts_ms     INTEGER NOT NULL,
  fetch_ms  INTEGER,
  best_bid  TEXT,
  best_ask  TEXT,
  mid       TEXT,
  bid_depth_base TEXT,
  ask_depth_base TEXT,
  levels_gz BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ticker_ts ON snapshots(ticker, ts_ms);

CREATE TABLE IF NOT EXISTS ref_prices (
  ticker TEXT NOT NULL,
  ts_ms  INTEGER NOT NULL,
  mid    TEXT NOT NULL,
  PRIMARY KEY (ticker, ts_ms)
);

CREATE TABLE IF NOT EXISTS ticks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_hash      TEXT NOT NULL REFERENCES orders(order_hash),
  ts_ms           INTEGER NOT NULL,
  snapshot_id     INTEGER REFERENCES snapshots(id),
  snapshot_age_ms INTEGER,
  degraded        INTEGER NOT NULL,
  exclusive       INTEGER NOT NULL DEFAULT 0,
  remaining_maker TEXT NOT NULL,
  rate_bump       INTEGER,
  insufficient_depth INTEGER NOT NULL DEFAULT 0,
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
  kyber_degraded   INTEGER,
  kyber_gas_cost   TEXT,
  kyber_fee        TEXT,
  edge_kyber       TEXT,
  bebop_out        TEXT,
  bebop_age_ms     INTEGER,
  bebop_degraded   INTEGER,
  bebop_gas_cost   TEXT,
  bebop_fee        TEXT,
  edge_bebop       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ticks_order ON ticks(order_hash, ts_ms);

CREATE TABLE IF NOT EXISTS gas_samples (
  ts_ms         INTEGER PRIMARY KEY,
  gas_price_wei TEXT,
  base_fee_wei  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES runs(id),
  ts_ms  INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
`;
