/** Fills vs_target_usd on rows written before the column existed.
 *
 *   CHAIN=cicada npx tsx scripts/backfill-target-edge.ts [--apply]
 *
 *  The target strip reported edge_usd, which measures us against the best rival
 *  in the auction rather than against the target — so "edge where we beat them"
 *  summed a different comparison than its label and came out negative on
 *  auctions we had won on price.
 *
 *  Recoverable without the price vector: surplus_usd and our_score fix the
 *  native-to-USD rate for the row, and the gap to the target is a plain
 *  difference of two scores at that rate.
 *
 *      vs_target_usd = surplus_usd * (our_score - target_score) / our_score
 *
 *  Only rows with a positive our_score can be inverted; a zero score carries no
 *  surplus to derive the rate from. Derived from raw columns, so re-running is
 *  a no-op. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';

const apply = process.argv.includes('--apply');
const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });

const EXPR = `
  CASE WHEN target_score IS NULL OR NULLIF(our_score,'')::numeric IS NULL
            OR NULLIF(our_score,'')::numeric <= 0 OR surplus_usd IS NULL THEN NULL
       ELSE surplus_usd
            * (NULLIF(our_score,'')::numeric - NULLIF(target_score,'')::numeric)
            / NULLIF(our_score,'')::numeric END`;

const rows = await db.all(
  `SELECT cow_auction_id AS auction, pair, round(size_usd::numeric,0) AS size,
          beat_target, round(vs_target_bps::numeric,2) AS vs_bps,
          round(edge_usd::numeric,4) AS old_edge_vs_best_rival,
          round((${EXPR})::numeric,4) AS new_edge_vs_target
   FROM orders WHERE target_bid IS TRUE ORDER BY resolved_at_ms DESC`);
console.table(rows);

if (apply) {
  await db.all(`UPDATE orders SET vs_target_usd = ${EXPR} WHERE target_bid IS TRUE`);
  const t = await db.get(
    `SELECT count(*) FILTER (WHERE beat_target) AS beat,
            round(sum(vs_target_usd) FILTER (WHERE beat_target)::numeric,4) AS edge_where_we_beat,
            round(sum(edge_usd) FILTER (WHERE beat_target)::numeric,4) AS old_figure
     FROM orders WHERE target_bid IS TRUE`);
  console.log('\n  card now:', t);
} else {
  console.log('\n  dry run — pass --apply to write');
}
await db.close();
