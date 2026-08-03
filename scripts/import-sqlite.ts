/** One-way import of a collector SQLite file into its Postgres schema.
 *
 *   npm run import:sqlite -- ./shadow-eth.sqlite
 *
 *  Row ids are preserved verbatim. Each chain owns a separate Postgres schema,
 *  so the two files' id spaces never meet and the foreign keys that point at
 *  runs/snapshots stay valid without remapping. Sequences are set past the
 *  imported maximum at the end so the collector's next insert doesn't collide.
 *
 *  Reads the SQLite file read-only and never writes to it. Safe to re-run: it
 *  refuses to import into a non-empty schema unless --force is passed, and then
 *  skips conflicting rows rather than overwriting them.
 *
 *  Needs better-sqlite3, which is an optional dependency — run this from the
 *  machine that holds the .sqlite files (probably not the collector VM). */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';
import { config } from '../config.js';
import { migrate } from '../src/db/db.js';
import { schemaFor } from '../src/db/schema.js';

const BATCH = 500;

/** Column order matters only in that both sides must agree; we read it from the
 *  SQLite table itself so a schema drift shows up as a missing-column error
 *  rather than silently shifted values. */
interface TableSpec {
  name: string;
  /** columns that exist in Postgres but not in the SQLite source */
  added?: string[];
  /** BLOB columns needing a Buffer round trip */
  blobs?: string[];
}

const TABLES: TableSpec[] = [
  { name: 'runs' },
  { name: 'orders', added: ['size_usd'] },
  { name: 'fills' },
  { name: 'snapshots', blobs: ['levels_gz'] },
  { name: 'ref_prices' },
  { name: 'ticks' },
  { name: 'gas_samples' },
  { name: 'events' },
];

const SEQUENCES: Array<{ table: string; column: string }> = [
  { table: 'runs', column: 'id' },
  { table: 'snapshots', column: 'id' },
  { table: 'ticks', column: 'id' },
  { table: 'events', column: 'id' },
];

const sqlitePath = process.argv[2];
const force = process.argv.includes('--force');
if (!sqlitePath || !existsSync(sqlitePath)) {
  console.error('usage: npm run import:sqlite -- <path-to.sqlite> [--force]');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const schema = schemaFor(config.chainId);
console.log(`importing ${sqlitePath} -> schema ${schema} (${config.chainLabel})`);

await migrate(connectionString, config.chainId);

const src = new Database(sqlitePath, { readonly: true });
const pool = new pg.Pool({
  connectionString,
  ssl: /sslmode=disable/.test(connectionString) || /\.railway\.internal/.test(connectionString)
    ? false
    : { rejectUnauthorized: false },
  max: 1,
});
const client = await pool.connect();
await client.query(`SET search_path TO ${schema}`);

// Refuse to layer an import on top of existing data unless asked.
const existing = await client.query(`SELECT COUNT(*)::int AS c FROM orders`);
if (existing.rows[0].c > 0 && !force) {
  console.error(
    `schema ${schema} already holds ${existing.rows[0].c} orders. Re-run with --force to add to it (conflicting rows are skipped).`
  );
  process.exit(1);
}

/** Postgres columns of a table, in ordinal order. */
async function pgColumns(table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, table]
  );
  return r.rows.map((x) => x.column_name);
}

let grandTotal = 0;
for (const spec of TABLES) {
  const target = await pgColumns(spec.name);
  const added = new Set(spec.added ?? []);
  const cols = target.filter((c) => !added.has(c));

  const sqliteCols = new Set(
    (src.pragma(`table_info(${spec.name})`) as Array<{ name: string }>).map((c) => c.name)
  );
  const missing = cols.filter((c) => !sqliteCols.has(c));
  if (missing.length > 0) {
    console.error(`  ${spec.name}: source is missing ${missing.join(', ')} — aborting`);
    process.exit(1);
  }

  const total = (src.prepare(`SELECT COUNT(*) AS c FROM ${spec.name}`).get() as { c: number }).c;
  if (total === 0) {
    console.log(`  ${spec.name}: empty`);
    continue;
  }

  const colList = cols.map((c) => `"${c}"`).join(', ');
  const rows = src.prepare(`SELECT ${colList} FROM ${spec.name}`).iterate() as Iterable<
    Record<string, unknown>
  >;

  let batch: unknown[][] = [];
  let done = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const values: unknown[] = [];
    const tuples = batch.map((row, i) => {
      const marks = row.map((_, j) => `$${i * cols.length + j + 1}`);
      values.push(...row);
      return `(${marks.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${spec.name} (${colList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values
    );
    done += batch.length;
    batch = [];
    process.stdout.write(`\r  ${spec.name}: ${done}/${total}`);
  };

  await client.query('BEGIN');
  for (const row of rows) {
    batch.push(
      cols.map((c) => {
        const v = row[c];
        // better-sqlite3 hands BLOBs back as Buffer already; anything else that
        // should be bytea would be a schema mismatch, so leave it alone.
        return v;
      })
    );
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  await client.query('COMMIT');
  process.stdout.write(`\r  ${spec.name}: ${done}/${total}\n`);
  grandTotal += done;
}

// Sequences start at 1; without this the collector's first insert would collide
// with an imported row.
for (const s of SEQUENCES) {
  await client.query(
    `SELECT setval(pg_get_serial_sequence('${schema}.${s.table}', '${s.column}'),
                   GREATEST((SELECT COALESCE(MAX(${s.column}), 0) FROM ${s.table}), 1))`
  );
}

// size_usd is new in the Postgres schema and can't be recovered from the
// SQLite rows; backfill what the ticks already know so the funnel isn't blank
// for imported history.
const backfilled = await client.query(
  `UPDATE orders o SET size_usd = sub.usd FROM (
     SELECT DISTINCT ON (order_hash) order_hash, notional_usdc::numeric / 1e6 AS usd
     FROM ticks WHERE notional_usdc IS NOT NULL ORDER BY order_hash, ts_ms
   ) sub WHERE sub.order_hash = o.order_hash AND o.size_usd IS NULL`
);
console.log(`size_usd backfilled for ${backfilled.rowCount} orders from their first priced tick`);

client.release();
await pool.end();
src.close();
console.log(`done: ${grandTotal.toLocaleString('en-US')} rows into ${schema}`);
console.log('note: decided_outcomes is not imported; run scripts/backfill-outcomes.ts to build it');
