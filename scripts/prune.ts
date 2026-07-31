/** Retention. Keeps what the research needs — filled orders and the venue
 *  prices we fetched — and drops what only costs space.
 *
 *   CHAIN=base npm run prune              # apply
 *   CHAIN=base npm run prune -- --dry-run # report what would go
 *
 *  What is kept forever:
 *    - every decided_outcomes / decided_venue_outcomes row. These are the
 *      verdicts the dashboard reads, for filled and unfilled orders alike, so
 *      pruning never changes what the dashboard shows.
 *    - filled orders and all of their ticks, which are the venue prices.
 *    - fills, runs, purged_stats.
 *
 *  What is dropped, once older than the retention window:
 *    - ticks belonging to orders that ended in anything other than 'filled'.
 *      Their verdict is already computed; what is lost is the ability to
 *      re-run the report's sensitivity grid over them later.
 *    - orders on pairs we cannot hedge. These are never priced and carry no
 *      venue data — on Base they are 57k of 58k rows. Their contribution to
 *      "auctions seen" is preserved in purged_stats.
 *    - order books no surviving tick refers to.
 */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';

const dryRun = process.argv.includes('--dry-run');
const KEEP_DAYS = Number(process.env.PRUNE_KEEP_DAYS ?? 3);
const cutoff = Date.now() - KEEP_DAYS * 86_400_000;

const db = await Db.open(config.chainId);
const label = `${config.chainLabel} (keep ${KEEP_DAYS}d, cutoff ${new Date(cutoff).toISOString()})`;
console.log(`${dryRun ? 'DRY RUN — ' : ''}pruning ${label}`);

const before = await db.get<{ size: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);

/** Rows a statement would touch, without touching them. */
async function countFor(what: string, sql: string): Promise<number> {
  const r = await db.get<{ c: number }>(`SELECT count(*) AS c FROM (${sql}) AS q`);
  console.log(`  ${what.padEnd(38)} ${(r?.c ?? 0).toLocaleString('en-US')}`);
  return r?.c ?? 0;
}

// --- 1. ticks for orders that did not fill -------------------------------
const DEAD_TICKS = `
  SELECT t.id FROM ticks t JOIN orders o ON o.order_hash = t.order_hash
  WHERE o.terminal_status IS NOT NULL
    AND o.terminal_status <> 'filled'
    AND o.terminal_at_ms < ${cutoff}`;
const deadTicks = await countFor('ticks of non-filled orders', DEAD_TICKS);

// --- 2. orders on pairs we cannot hedge ----------------------------------
const NOISE_ORDERS = `
  SELECT order_hash FROM orders
  WHERE eligible = 0 AND kyber_only = 0 AND received_at_ms < ${cutoff}`;
const noiseOrders = await countFor('unhedgeable orders (never priced)', NOISE_ORDERS);

if (dryRun) {
  console.log(`\ncurrent size ${before?.size}. Nothing changed.`);
  await db.close();
  process.exit(0);
}

// Order matters: ticks reference snapshots and orders, so they go first.
if (deadTicks > 0) {
  await db.all(`DELETE FROM ticks t USING orders o
                WHERE o.order_hash = t.order_hash
                  AND o.terminal_status IS NOT NULL
                  AND o.terminal_status <> 'filled'
                  AND o.terminal_at_ms < ?`, [cutoff]);
  console.log(`  deleted ${deadTicks.toLocaleString('en-US')} ticks`);
}

if (noiseOrders > 0) {
  // Counted before deletion so "auctions seen" stays truthful afterwards.
  await db.all(
    `INSERT INTO purged_stats (kind, count, last_purge_ms) VALUES ('unhedgeable_orders', ?, ?)
     ON CONFLICT (kind) DO UPDATE SET count = purged_stats.count + EXCLUDED.count,
                                      last_purge_ms = EXCLUDED.last_purge_ms`,
    [noiseOrders, Date.now()]
  );
  await db.all(
    `DELETE FROM orders WHERE eligible = 0 AND kyber_only = 0 AND received_at_ms < ?`,
    [cutoff]
  );
  console.log(`  deleted ${noiseOrders.toLocaleString('en-US')} unhedgeable orders`);
}

// --- 3. order books nothing refers to any more ---------------------------
const snaps = await db.all<{ c: number }>(
  `WITH gone AS (
     DELETE FROM snapshots s
     WHERE s.ts_ms < ? AND NOT EXISTS (SELECT 1 FROM ticks t WHERE t.snapshot_id = s.id)
     RETURNING 1
   ) SELECT count(*) AS c FROM gone`,
  [cutoff]
);
console.log(`  deleted ${(snaps[0]?.c ?? 0).toLocaleString('en-US')} unreferenced snapshots`);

// Plain VACUUM makes the freed pages reusable by later inserts, which is what
// keeps the database from growing, but it does not hand the space back — after
// a large purge the table stays at its high-water mark. --full rewrites the
// table to actually shrink it, at the cost of an exclusive lock (seconds at
// these sizes, and the collector's writes simply queue behind it). Worth it
// once after a big deletion; not worth it on a routine run.
const TABLES = ['ticks', 'orders', 'snapshots'];
for (const t of TABLES) {
  await db.all(process.argv.includes('--full') ? `VACUUM (FULL, ANALYZE) ${t}` : `VACUUM (ANALYZE) ${t}`);
}

const after = await db.get<{ size: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
console.log(`\ndatabase ${before?.size} -> ${after?.size}`);
await db.close();
