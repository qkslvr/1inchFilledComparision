/** Re-decides every recorded win over whole solutions instead of single orders.
 *
 *   CHAIN=cicada npx tsx scripts/backfill-batch-verdicts.ts
 *
 *  Idempotent, and reads nothing but stored scores — no re-quoting, no network.
 *  Safe to re-run as an auction's remaining orders resolve. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';
import { recomputeBatchVerdicts } from '../src/cow/batchverdict.js';

const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });

// Restate the fee on the same believable size the volume column uses.
//
// It used to be 5 bps of the venue's own valuation of our quote, which nothing
// sanity-checked. One aArbWETH/aArbUSDCn row whose size was rejected as nonsense
// still booked $29,019 — 30% of the reported total. Where we have no size we now
// have no fee, which is the same answer the volume column already gives.
//
// The fill fraction cannot be recovered here: `filled_maker_total` was written
// as the whole limit on every row, so history reads as a 100% fill throughout.
// New rows record what actually settled; these keep a whole-order fee.
const feeBps = new Map<string, bigint>([
  ['kalqix', config.kalqixTakerFeeBps],
  ['kyber', config.kyber.feeBps],
  ['bebop', config.bebop.feeBps],
]);
const feeCase = [...feeBps].map(([v, b]) => `WHEN '${v}' THEN ${Number(b)}`).join(' ');
const feeBefore = await db.get<{ total: number; rows: number }>(
  `SELECT COALESCE(sum(fee_usd),0) AS total, count(*) FILTER (WHERE fee_usd IS NOT NULL) AS rows
   FROM orders WHERE resolved_at_ms IS NOT NULL`
);
await db.all(
  `UPDATE orders SET fee_usd = CASE
     WHEN size_usd IS NULL OR size_usd <= 0 THEN NULL
     ELSE size_usd * (CASE our_best_venue ${feeCase} ELSE 5 END) / 10000.0 END
   WHERE resolved_at_ms IS NOT NULL`
);
const feeAfter = await db.get<{ total: number; rows: number }>(
  `SELECT COALESCE(sum(fee_usd),0) AS total, count(*) FILTER (WHERE fee_usd IS NOT NULL) AS rows
   FROM orders WHERE resolved_at_ms IS NOT NULL`
);
console.log(`${config.chainLabel}: fee restated`);
console.log(`  was  $${Math.round(Number(feeBefore?.total ?? 0)).toLocaleString()} over ${feeBefore?.rows} rows`);
console.log(`  now  $${Math.round(Number(feeAfter?.total ?? 0)).toLocaleString()} over ${feeAfter?.rows} rows\n`);

const s = await recomputeBatchVerdicts(db);

console.log(`${config.chainLabel}: atomic verdicts`);
console.log(`  orders decided      ${s.decided}`);
console.log(`  in multi-order      ${s.batched}`);
console.log(`  wins (atomic)       ${s.won}`);
console.log(`  demoted             ${s.demoted}  (won the order, lost the bundle)`);
console.log(`  promoted            ${s.promoted}  (lost the order, won on the total)`);

const split = await db.all(
  `SELECT batch_size, count(*) AS orders,
          count(*) FILTER (WHERE batch_won = 1) AS won,
          count(*) FILTER (WHERE won = 1) AS won_per_order
   FROM orders WHERE batch_won IS NOT NULL GROUP BY 1 ORDER BY 1`
);
console.log(`\n  bundle  orders   atomic wins   per-order wins`);
for (const r of split) {
  console.log(
    `  ${String(r.batch_size).padStart(6)}  ${String(r.orders).padStart(6)}` +
      `  ${String(r.won).padStart(11)}   ${String(r.won_per_order).padStart(14)}`
  );
}

await db.close();
