/** Re-decides every recorded win over whole solutions instead of single orders.
 *
 *   CHAIN=cicada npx tsx scripts/backfill-batch-verdicts.ts
 *
 *  Idempotent, and reads nothing but stored scores — no re-quoting, no network.
 *  Safe to re-run as an auction's remaining orders resolve. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';
import { recomputeBatchVerdicts } from '../src/cow/batchverdict.js';

// The fee restatement that used to live here has moved to backfill-fees.ts.
// It billed size_usd * 5bps flat, so re-running this script overwrote every
// fill-scaled fee with a whole-order one — $448 of real fee on partial fills
// came back as $70,427. Verdict work and money work do not belong in one pass.

const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });

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
