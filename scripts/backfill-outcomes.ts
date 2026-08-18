/** Builds decided_outcomes for orders that finished before the collector started
 *  writing verdicts — i.e. everything imported from SQLite.
 *
 *   npm run backfill:outcomes
 *
 *  Idempotent: only touches orders that have no verdict yet, unless --all. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';
import { buildDecidedOutcome, OUTCOME_TICK_SQL } from '../src/report/outcome.js';

const all = process.argv.includes('--all');
const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });

const orders = await db.all(
  `SELECT o.order_hash, o.pair, o.terminal_status, o.terminal_at_ms,
          o.t_actual_ws_ms, o.t_actual_chain_ms, o.late_seen,
          o.maker_asset, o.taker_asset, o.size_usd
   FROM orders o
   WHERE (o.eligible = 1 OR o.kyber_only = 1) AND o.terminal_status IS NOT NULL
   ${all ? '' : 'AND NOT EXISTS (SELECT 1 FROM decided_outcomes d WHERE d.order_hash = o.order_hash)'}
   ORDER BY o.terminal_at_ms`
);

console.log(`${config.chainLabel}: ${orders.length} order(s) to classify`);

let done = 0;
for (const row of orders) {
  const raw = await db.all(OUTCOME_TICK_SQL, [row.order_hash]);
  db.upsertDecidedOutcome(buildDecidedOutcome(row, raw));
  if (++done % 200 === 0) {
    await db.flush();
    process.stdout.write(`\r  ${done}/${orders.length}`);
  }
}
await db.flush();
process.stdout.write(`\r  ${done}/${orders.length}\n`);

const summary = await db.all(
  `SELECT venue, cls, COUNT(*) AS c FROM decided_venue_outcomes
   WHERE has_data = 1 GROUP BY venue, cls ORDER BY venue, c DESC`
);
for (const r of summary) console.log(`  ${r.venue.padEnd(7)} ${r.cls.padEnd(14)} ${r.c}`);

await db.close();
