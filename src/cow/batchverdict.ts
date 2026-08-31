/** Re-decides every win atomically, over whole solutions rather than orders.
 *
 *  A CoW solution settles all-or-nothing. A solver bundling two orders has to
 *  beat the field on the bundle; it cannot take the leg it likes and leave the
 *  other. Our `won` column asked a different and easier question — "did our
 *  quote beat theirs on THIS order" — and so recorded 61 auctions where we won
 *  one order of a batch and lost another, a result no solver could have had.
 *
 *  The honest test is the one the winner actually passed: take the set of orders
 *  its solution covered, and require that we clear the same set, in total. That
 *  cuts both ways. A batch where we win big on one leg and lose narrowly on the
 *  other can still come out ahead on the sum, so this is a recount, not a filter.
 *
 *  Two limits worth stating rather than hiding:
 *
 *  - We only see orders we tracked, so a winner's bundle may extend past what
 *    `solution_bids` knows about. The reconstructed set is a subset, which
 *    flatters us. `batch_size` records how much of it we saw.
 *  - A bundle we cannot fully cover is a loss. If any order in it has no score
 *    of ours, we could not have submitted that solution at all.
 *
 *  The bar is the best total any solver could have shown over that order set,
 *  which is at least the winner's. Comparing only with the winner would have
 *  been laxer than the per-order column it replaces, and turned 45 losses into
 *  wins for no better reason than that the rival who beat us on one leg had
 *  lost the auction on another. */
import type { Db } from '../db/db.js';

export interface VerdictSummary {
  /** orders that carry an atomic verdict */
  decided: number;
  /** orders whose verdict is a win under the atomic rule */
  won: number;
  /** orders that used to read as wins and no longer do */
  demoted: number;
  /** orders that used to read as losses and now win on the bundle total */
  promoted: number;
  /** orders in a multi-order bundle */
  batched: number;
}

/** One statement, so it needs no transaction of its own — the pool hands out a
 *  fresh connection per call, and a BEGIN here would not reliably enclose the
 *  work that followed it.
 *
 *  `bool_and(... IS NOT NULL)` rather than a plain SUM: summing nulls away would
 *  silently score a bundle we only partly covered as if we had covered it. */
const APPLY_SQL = `
WITH win_bundle AS (
  SELECT o.cow_auction_id AS auction, b.solver AS winner, b.order_hash
  FROM solution_bids b
  JOIN orders o ON o.order_hash = b.order_hash
  WHERE b.is_winner = 1
    AND o.cow_auction_id IS NOT NULL
    AND o.resolved_at_ms IS NOT NULL
),
bundle AS (
  SELECT auction, winner, count(*) AS n_orders FROM win_bundle GROUP BY 1, 2
),
-- Every solver's total over that same order set. The bar is the best of them,
-- not the winner's: a solution can lose overall while still offering more on
-- these particular orders, and claiming a win over the winner alone would be
-- quietly lowering the bar that the per-order column already held us to.
rival AS (
  SELECT w.auction, w.winner, b.solver,
         count(*)                                        AS covered,
         sum(COALESCE(NULLIF(b.score, ''), '0')::numeric) AS total
  FROM win_bundle w
  JOIN solution_bids b ON b.order_hash = w.order_hash
  GROUP BY 1, 2, 3
),
rival_best AS (
  SELECT r.auction, r.winner, max(r.total) AS best_total
  FROM rival r
  JOIN bundle bd ON bd.auction = r.auction AND bd.winner = r.winner
  -- A solver that did not price every order of the set could not have submitted
  -- this solution, so its partial total is not a bar we have to clear.
  WHERE r.covered = bd.n_orders
  GROUP BY 1, 2
),
ours AS (
  SELECT w.auction, w.winner,
         CASE WHEN bool_and(o.our_score IS NOT NULL)
              THEN sum(COALESCE(NULLIF(o.our_score, ''), '0')::numeric) END AS total
  FROM win_bundle w
  JOIN orders o ON o.order_hash = w.order_hash
  GROUP BY 1, 2
),
verdict AS (
  SELECT w.order_hash, bd.n_orders,
         CASE WHEN ou.total IS NOT NULL AND ou.total > COALESCE(rb.best_total, 0)
              THEN 1 ELSE 0 END AS win
  FROM win_bundle w
  JOIN bundle bd     ON bd.auction = w.auction AND bd.winner = w.winner
  JOIN ours ou       ON ou.auction = w.auction AND ou.winner = w.winner
  LEFT JOIN rival_best rb ON rb.auction = w.auction AND rb.winner = w.winner
)
UPDATE orders o
SET batch_won = v.win, batch_size = v.n_orders
FROM verdict v
WHERE o.order_hash = v.order_hash
  AND (o.batch_won IS DISTINCT FROM v.win OR o.batch_size IS DISTINCT FROM v.n_orders)`;

/** Recompute atomic verdicts across the whole dataset.
 *
 *  Cheap enough to run on a timer: it is two aggregates over solution_bids and
 *  an update restricted to rows whose verdict actually moved. Safe to repeat —
 *  the result depends only on stored scores, so it converges as an auction's
 *  orders finish resolving. */
export async function recomputeBatchVerdicts(db: Db): Promise<VerdictSummary> {
  const before = await db.all<{ order_hash: string; won: number | null }>(
    `SELECT order_hash, won FROM orders WHERE resolved_at_ms IS NOT NULL`
  );
  const wasWon = new Map(before.map((r) => [r.order_hash, r.won]));

  await db.all(APPLY_SQL);

  const after = await db.all<{ order_hash: string; batch_won: number | null; batch_size: number }>(
    `SELECT order_hash, batch_won, batch_size FROM orders WHERE batch_won IS NOT NULL`
  );
  const s: VerdictSummary = { decided: 0, won: 0, demoted: 0, promoted: 0, batched: 0 };
  for (const r of after) {
    s.decided++;
    if (r.batch_won === 1) s.won++;
    if (r.batch_size > 1) s.batched++;
    const old = wasWon.get(r.order_hash);
    if (old === 1 && r.batch_won === 0) s.demoted++;
    if (old === 0 && r.batch_won === 1) s.promoted++;
  }
  return s;
}
