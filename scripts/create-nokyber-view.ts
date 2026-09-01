/** Builds a read-only dataset that answers "what if we had no Kyber?"
 *
 *   CHAIN=cicada npx tsx scripts/create-nokyber-view.ts
 *
 *  No new collection. Every quote we need is already in `ticks`, which records
 *  each venue's edge on every round, so the counterfactual bid is the better of
 *  KalqiX and Bebop on the tick that formed the real bid.
 *
 *  It is built as a SCHEMA OF VIEWS rather than a new collector or a fork of the
 *  dashboard queries: the collector addresses tables unqualified and lets
 *  search_path pick the dataset, so a schema whose `orders` is a view over the
 *  real one — and whose other tables are plain pass-throughs — is read by every
 *  existing query with no code change at all.
 *
 *  Scores scale rather than being recomputed from prices. Our score is linear in
 *  the edge, so dropping a venue scales it by altEdge/baseEdge. That needs no
 *  price, which matters because most historical rows have none stored. Since
 *  `our_bid_out` is already the best of all three venues, the alternative edge
 *  can never exceed it: the ratio is bounded by 1 and this dataset can only ever
 *  be worse than the full one, which is the right shape for the question. */
import { Client } from 'pg';
import { config } from '../config.js';

const SRC = 'cicada_42161';
const DST = 'cicada_nokyber_42161';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const c = new Client({ connectionString: url });
await c.connect();

// IF EXISTS is no help here: DROP VIEW on a materialised view raises
// DropErrorMsgWrongType, and so does DROP MATERIALIZED VIEW on a plain one. Both
// orders of the two statements are wrong in one direction, so ask what the
// relation actually is and issue the matching drop.
const { rows: existing } = await c.query<{ relkind: string }>(
  `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = 'orders'`, [DST]);
const kind = existing[0]?.relkind;
if (kind === 'm') await c.query(`DROP MATERIALIZED VIEW ${DST}.orders CASCADE`);
else if (kind === 'v') await c.query(`DROP VIEW ${DST}.orders CASCADE`);
else if (kind) await c.query(`DROP TABLE ${DST}.orders CASCADE`);

const { rows: cols } = await c.query<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns
   WHERE table_schema = $1 AND table_name = 'orders' ORDER BY ordinal_position`, [SRC]);
if (!cols.length) throw new Error(`no ${SRC}.orders to build from`);

/** Columns the counterfactual changes; everything else passes through. */
const OVERRIDE: Record<string, string> = {
  our_best_venue: `a.alt_venue`,
  our_bid_out: `CASE WHEN a.alt_venue IS NULL THEN NULL
                     ELSE round(NULLIF(o.limit_buy_amount,'')::numeric + GREATEST(a.alt_edge, 0))::text END`,
  our_score: `CASE WHEN a.alt_venue IS NULL THEN NULL
                   ELSE round(COALESCE(NULLIF(o.our_score,'')::numeric, 0) * a.s)::text END`,
  surplus_usd: `CASE WHEN a.alt_venue IS NULL THEN NULL ELSE o.surplus_usd * a.s END`,
  // Same size and the same 5 bps whichever venue fills it, so the only change is
  // that an order we could not have bid on earns nothing.
  fee_usd: `CASE WHEN a.alt_venue IS NULL THEN NULL ELSE o.fee_usd END`,
  // The rival's surplus in dollars is recovered from the original row's own
  // score-to-USD rate, then subtracted from the scaled surplus.
  edge_usd: `CASE WHEN a.alt_venue IS NULL OR NULLIF(o.our_score,'')::numeric IS NULL
                    OR NULLIF(o.our_score,'')::numeric <= 0 THEN NULL
                  ELSE o.surplus_usd * a.s
                       - o.surplus_usd * COALESCE(NULLIF(o.best_rival_score,'')::numeric,0)
                         / NULLIF(o.our_score,'')::numeric END`,
  // Expressed against trade size rather than native notional. The full dataset
  // measures this in native wei; stated here in bps of size_usd so it stays
  // computable without the price vector. Same units, slightly different base.
  score_margin_bps: `CASE WHEN a.alt_venue IS NULL OR o.size_usd IS NULL OR o.size_usd <= 0
                            OR NULLIF(o.our_score,'')::numeric IS NULL
                            OR NULLIF(o.our_score,'')::numeric <= 0 THEN NULL
                          ELSE 10000.0 * (o.surplus_usd * a.s
                               - o.surplus_usd * COALESCE(NULLIF(o.best_rival_score,'')::numeric,0)
                                 / NULLIF(o.our_score,'')::numeric) / o.size_usd END`,
  won: `CASE WHEN a.alt_venue IS NULL THEN NULL
             WHEN COALESCE(NULLIF(o.our_score,'')::numeric,0) * a.s
                  > COALESCE(NULLIF(o.best_rival_score,'')::numeric,0) THEN 1 ELSE 0 END`,
  batch_won: `v.bw`,
};

const select = cols
  .map(({ column_name: n }) => `${OVERRIDE[n] ?? `o.${n}`} AS ${n}`)
  .join(',\n         ');

const SQL = `
CREATE SCHEMA IF NOT EXISTS ${DST};

CREATE MATERIALIZED VIEW ${DST}.orders AS
WITH bid_tick AS (
  -- The tick that formed the bid: the last one at or before we bid.
  SELECT DISTINCT ON (t.order_hash) t.order_hash,
         NULLIF(t.edge_default,'')::numeric AS e_kalqix,
         NULLIF(t.edge_bebop,'')::numeric   AS e_bebop
  FROM ${SRC}.ticks t
  JOIN ${SRC}.orders o ON o.order_hash = t.order_hash
  WHERE o.bid_at_ms IS NULL OR t.ts_ms <= o.bid_at_ms
  ORDER BY t.order_hash, t.ts_ms DESC
),
alt AS (
  SELECT o.order_hash,
         CASE WHEN bt.e_kalqix IS NULL AND bt.e_bebop IS NULL THEN NULL
              WHEN COALESCE(bt.e_kalqix, '-Infinity'::numeric)
                   >= COALESCE(bt.e_bebop, '-Infinity'::numeric) THEN 'kalqix'
              ELSE 'bebop' END AS alt_venue,
         GREATEST(COALESCE(bt.e_kalqix, '-Infinity'::numeric),
                  COALESCE(bt.e_bebop,  '-Infinity'::numeric)) AS alt_edge,
         CASE
           WHEN bt.e_kalqix IS NULL AND bt.e_bebop IS NULL THEN NULL
           WHEN NULLIF(o.our_bid_out,'')::numeric IS NULL THEN 0
           WHEN NULLIF(o.our_bid_out,'')::numeric - NULLIF(o.limit_buy_amount,'')::numeric <= 0 THEN 0
           WHEN GREATEST(COALESCE(bt.e_kalqix,'-Infinity'::numeric),
                         COALESCE(bt.e_bebop,'-Infinity'::numeric)) <= 0 THEN 0
           ELSE LEAST(1.0, GREATEST(COALESCE(bt.e_kalqix,'-Infinity'::numeric),
                                    COALESCE(bt.e_bebop,'-Infinity'::numeric))
                           / (NULLIF(o.our_bid_out,'')::numeric
                              - NULLIF(o.limit_buy_amount,'')::numeric))
         END AS s
  FROM ${SRC}.orders o
  LEFT JOIN bid_tick bt ON bt.order_hash = o.order_hash
),
alt_score AS (
  SELECT o.order_hash, o.cow_auction_id,
         CASE WHEN a.alt_venue IS NULL THEN NULL
              ELSE COALESCE(NULLIF(o.our_score,'')::numeric,0) * a.s END AS sc
  FROM ${SRC}.orders o JOIN alt a ON a.order_hash = o.order_hash
),
bundle AS (
  SELECT o.cow_auction_id AS auction, b.solver,
         count(*)                         AS legs_tracked,
         max(b.solution_orders)           AS legs_total,
         max(b.solution_score::numeric)   AS bar,
         CASE WHEN bool_and(x.sc IS NOT NULL) THEN sum(x.sc) END AS ours
  FROM ${SRC}.solution_bids b
  JOIN ${SRC}.orders o  ON o.order_hash = b.order_hash
  JOIN alt_score x      ON x.order_hash = b.order_hash
  WHERE b.is_winner = 1 AND o.resolved_at_ms IS NOT NULL AND o.cow_auction_id IS NOT NULL
  GROUP BY 1, 2
),
verdict AS (
  SELECT b.order_hash,
         CASE WHEN bd.bar IS NULL OR bd.legs_total IS NULL
                   OR bd.legs_tracked <> bd.legs_total THEN NULL
              WHEN bd.ours IS NULL THEN 0
              WHEN bd.ours > bd.bar THEN 1 ELSE 0 END AS bw
  FROM ${SRC}.solution_bids b
  JOIN ${SRC}.orders o ON o.order_hash = b.order_hash
  JOIN bundle bd ON bd.auction = o.cow_auction_id AND bd.solver = b.solver
  WHERE b.is_winner = 1
)
SELECT ${select}
FROM ${SRC}.orders o
JOIN alt a          ON a.order_hash = o.order_hash
LEFT JOIN verdict v ON v.order_hash = o.order_hash;

-- The dashboard runs about ten queries per dataset per refresh, and as a plain
-- view each one re-ran the whole CTE chain: data.json took 21.8s. Materialised
-- it is a table scan. The unique index is what lets the refresh run CONCURRENTLY,
-- so the dashboard never reads a half-built relation.
CREATE UNIQUE INDEX IF NOT EXISTS nokyber_orders_pk ON ${DST}.orders (order_hash);
CREATE INDEX IF NOT EXISTS nokyber_orders_resolved ON ${DST}.orders (resolved_at_ms);
CREATE INDEX IF NOT EXISTS nokyber_orders_auction ON ${DST}.orders (cow_auction_id);
`;

await c.query(SQL);
console.log(`${DST}.orders materialised (${cols.length} columns, ${Object.keys(OVERRIDE).length} recomputed)`);

// Everything else passes straight through, so any query the dashboard makes
// resolves inside this schema rather than falling back to the real one.
const { rows: tables } = await c.query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND table_name <> 'orders'`, [SRC]);
for (const { table_name } of tables) {
  await c.query(`CREATE OR REPLACE VIEW ${DST}.${table_name} AS SELECT * FROM ${SRC}.${table_name}`);
}
console.log(`  ${tables.length} pass-through view(s)`);

const chk = await c.query(
  `SELECT count(*) AS orders,
          count(*) FILTER (WHERE our_best_venue IS NOT NULL) AS with_a_bid,
          count(*) FILTER (WHERE batch_won = 1) AS wins,
          round(sum(surplus_usd) FILTER (WHERE batch_won = 1)::numeric,2) AS surplus_won
   FROM ${DST}.orders WHERE resolved_at_ms IS NOT NULL`);
console.log('  ', chk.rows[0]);
await c.end();
