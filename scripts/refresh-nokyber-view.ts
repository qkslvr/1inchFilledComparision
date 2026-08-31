/** Refreshes the derived no-Kyber dataset.
 *
 *   npx tsx scripts/refresh-nokyber-view.ts
 *
 *  The view is materialised because the dashboard issues about ten queries per
 *  dataset per refresh and a plain view re-ran its whole CTE chain for each one,
 *  taking data.json from under a second to 21.8s. CONCURRENTLY so the dashboard
 *  never reads a half-built relation; it needs the unique index the create
 *  script adds. Run from cron — a few minutes of staleness is immaterial here,
 *  and the underlying dataset only moves as orders resolve. */
import { Client } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const c = new Client({ connectionString: url });
await c.connect();
const t0 = Date.now();
await c.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY cicada_nokyber_42161.orders`);
const r = await c.query(
  `SELECT count(*) AS orders, count(*) FILTER (WHERE batch_won = 1) AS wins
   FROM cicada_nokyber_42161.orders WHERE resolved_at_ms IS NOT NULL`);
console.log(`${new Date().toISOString()} refreshed in ${((Date.now()-t0)/1000).toFixed(1)}s`, r.rows[0]);
await c.end();
