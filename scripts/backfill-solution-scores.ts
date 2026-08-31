/** Fills solution_score / solution_orders from CoW's own competition record.
 *
 *   CHAIN=cicada npx tsx scripts/backfill-solution-scores.ts
 *
 *  The verdict compares our bundle total with the score CoW published for the
 *  winning solution. We only started storing that with the column, so every
 *  historical auction has to be fetched once. Without it those rows are
 *  undecidable — which is correct, but leaves the dataset almost empty.
 *
 *  Idempotent: skips auctions already filled, so it can be re-run after an
 *  interruption. One request per auction, paced. */
import { config } from '../config.js';
import { Db } from '../src/db/db.js';
import { getJsonOrNull } from '../src/http/json.js';

const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });

const todo = await db.all<{ id: string }>(`
  SELECT DISTINCT o.cow_auction_id AS id
  FROM orders o JOIN solution_bids b ON b.order_hash = o.order_hash AND b.is_winner = 1
  WHERE o.cow_auction_id IS NOT NULL AND b.solution_score IS NULL
  ORDER BY o.cow_auction_id DESC`);

console.log(`${config.chainLabel}: ${todo.length} auction(s) without a published score`);

let filled = 0, missing = 0, rows = 0;
for (const [i, { id }] of todo.entries()) {
  const raw: any = await getJsonOrNull(
    `${config.cow.apiBase}/${config.cow.chainSlug}/api/v2/solver_competition/${id}`, 20_000
  ).catch(() => null);
  const sols = (raw?.solutions ?? []).filter((s: any) => s.isWinner && s.score && s.orders?.length);
  if (!sols.length) { missing++; continue; }
  for (const sol of sols) {
    const solver = String(sol.solverAddress ?? '').toLowerCase();
    const uids: string[] = sol.orders.map((o: any) => o.id);
    const r = await db.all(
      `UPDATE solution_bids SET solution_score = $1, solution_orders = $2
       WHERE is_winner = 1 AND solver = $3 AND order_hash = ANY($4::text[])`,
      [String(sol.score), sol.orders.length, solver, uids]
    );
    rows += (r as any).length ?? 0;
  }
  filled++;
  if ((i + 1) % 100 === 0) {
    process.stdout.write(`\r  ${i + 1}/${todo.length}  filled ${filled}  missing ${missing}`);
  }
  await new Promise((res) => setTimeout(res, 320));
}
console.log(`\n  filled ${filled} auction(s), ${missing} not retrievable`);

const cov = await db.get(
  `SELECT count(*) AS winner_rows, count(solution_score) AS with_score
   FROM solution_bids WHERE is_winner = 1`);
console.log(`  coverage: ${cov?.with_score}/${cov?.winner_rows} winning rows now carry a published score`);
await db.close();
