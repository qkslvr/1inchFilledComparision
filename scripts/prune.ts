/** Retention. Keeps what the research needs — filled orders and the venue
 *  prices we fetched — and drops what only costs space.
 *
 *   npm run prune              # apply
 *   npm run prune -- --dry-run # report what would go
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
// One day, not three. Expired orders are ~86% of all ticks, and at the observed
// ingest rate a three-day window let the database reach its ceiling before any
// of it became eligible for deletion — the retention never got to run.
const KEEP_DAYS = Number(process.env.PRUNE_KEEP_DAYS ?? 1);
const cutoff = Date.now() - KEEP_DAYS * 86_400_000;

const db = await Db.open(config.chainId);
const label = `${config.chainLabel} (keep ${KEEP_DAYS}d, cutoff ${new Date(cutoff).toISOString()})`;
console.log(`${dryRun ? 'DRY RUN — ' : ''}pruning ${label}`);

const before = await db.get<{ size: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);

// Normal retention cannot save us from a burst. A burst's ticks belong to orders
// that are still open, or only just terminated, so nothing makes them eligible
// for deletion for a whole day — and 140 concurrent orders produce ~6 GB/day.
// Above a high-water mark, prune much harder: a Fusion auction lasts minutes, so
// an order still open hours later is one whose terminal status never arrived,
// and its ticks are the exact backlog that filled the disk twice.
// 250, not 350: at the burst rate measured on 29 July (4.1 MB/min) a 350 MB
// mark leaves 39 minutes before the ceiling, which a cron running any less often
// than that cannot act inside. 250 leaves ~64 minutes against a 15-minute cron.
const MAX_MB = Number(process.env.PRUNE_MAX_MB ?? 250);
const sizeRow = await db.get<{ mb: number }>(
  `SELECT (pg_database_size(current_database()) / 1048576)::int AS mb`
);
const underPressure = (sizeRow?.mb ?? 0) > MAX_MB;
// 45 minutes, not 6 hours. A burst fills the disk in under two hours, so its
// orders are never 6 hours old and that threshold would have matched nothing at
// exactly the moment it was needed. A Fusion auction runs for minutes, so 45
// minutes is already far past any order that is going to resolve normally.
const STALE_OPEN_MS = 45 * 60_000;
if (underPressure) {
  console.log(`  ! ${sizeRow?.mb} MB exceeds PRUNE_MAX_MB=${MAX_MB}: pruning aggressively`);
}

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

// --- 2b. under pressure only: ticks of orders stuck open ------------------
const STUCK_TICKS = `
  SELECT t.id FROM ticks t JOIN orders o ON o.order_hash = t.order_hash
  WHERE o.terminal_status IS NULL
    AND o.received_at_ms < ${Date.now() - STALE_OPEN_MS}`;
const stuckTicks = underPressure ? await countFor('ticks of long-stuck open orders', STUCK_TICKS) : 0;

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

if (stuckTicks > 0) {
  await db.all(
    `DELETE FROM ticks t USING orders o
     WHERE o.order_hash = t.order_hash AND o.terminal_status IS NULL AND o.received_at_ms < ?`,
    [Date.now() - STALE_OPEN_MS]
  );
  console.log(`  deleted ${stuckTicks.toLocaleString('en-US')} ticks of long-stuck open orders`);
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
