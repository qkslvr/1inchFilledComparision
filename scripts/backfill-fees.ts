/** Recomputes fee_usd from stored inputs: 5 bps of the believable size, scaled
 *  by the fraction of the order that actually settled.
 *
 *   CHAIN=cicada npx tsx scripts/backfill-fees.ts [--apply]
 *
 *  Two things this gets right that a flat 5-bps-of-size pass does not:
 *
 *  - A size we refuse to believe earns no fee. `sizeUsdFromQuote` rejects a
 *    valuation above maxBelievableSizeUsd; the old fee path did not, and one
 *    aArbWETH/aArbUSDCn row booked $29,019 on a size that had been discarded.
 *  - A partial fill is billed on what settled. Billing the whole order turned
 *    $448 of real fee across 256 rows into $70,427.
 *
 *  Derived entirely from raw inputs, so it is idempotent: running it twice gives
 *  the same answer as running it once. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';

const apply = process.argv.includes('--apply');
const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });

const feeCase = [
  ['kalqix', config.kalqixTakerFeePpm],
  ['kyber', config.kyber.feePpm],
  ['bebop', config.bebop.feePpm],
].map(([v, b]) => `WHEN '${v}' THEN ${Number(b)}`).join(' ');

/** The settled fraction, from the winning solution's own sell amount.
 *  `filled_maker_total` cannot be used: it was written as the whole limit on
 *  every row, so history reads as a 100% fill throughout. */
const FEE_EXPR = `
  CASE WHEN o.size_usd IS NULL OR o.size_usd <= 0 THEN NULL ELSE
    o.size_usd
    * (CASE o.our_best_venue ${feeCase} ELSE 5 END) / 10000.0
    * COALESCE((SELECT LEAST(1.0, b.sell_amount::numeric
                              / NULLIF(o.limit_sell_amount::numeric, 0))
                FROM solution_bids b
                WHERE b.order_hash = o.order_hash AND b.is_winner = 1
                LIMIT 1), 1.0)
  END`;

const before = await db.get<{ total: number; rows: number }>(
  `SELECT COALESCE(sum(fee_usd),0) AS total, count(fee_usd) AS rows
   FROM orders WHERE resolved_at_ms IS NOT NULL`);
const after = await db.get<{ total: number; rows: number }>(
  `SELECT COALESCE(sum(${FEE_EXPR}),0) AS total, count(${FEE_EXPR}) AS rows
   FROM orders o WHERE o.resolved_at_ms IS NOT NULL`);

console.log(`${config.chainLabel}: fee restated`);
console.log(`  was  $${Number(before?.total ?? 0).toFixed(2)} over ${before?.rows} rows`);
console.log(`  now  $${Number(after?.total ?? 0).toFixed(2)} over ${after?.rows} rows`);

if (apply) {
  await db.all(`UPDATE orders o SET fee_usd = ${FEE_EXPR} WHERE o.resolved_at_ms IS NOT NULL`);
  const won = await db.get<{ fee: number; surplus: number; n: string }>(
    `SELECT COALESCE(sum(fee_usd),0) AS fee, COALESCE(sum(surplus_usd),0) AS surplus,
            count(*) AS n FROM orders WHERE batch_won = 1`);
  console.log(`\n  on trades we won: ${won?.n} orders, fee $${Number(won?.fee).toFixed(2)}, surplus $${Number(won?.surplus).toFixed(2)}`);
} else {
  console.log('\n  dry run — pass --apply to write');
}
await db.close();
