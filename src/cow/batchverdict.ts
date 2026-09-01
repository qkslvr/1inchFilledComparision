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
 *    of ours — null, or zero, which means we could not clear that user's limit
 *    — we could not have submitted that solution at all.
 *
 *  The bar is the score CoW itself published for the winning solution, not one
 *  we rebuild from the amounts it delivered. Rebuilding it ran ~3% light on
 *  ordinary orders and ~70% light on partial fills, and since the test is "our
 *  score beats theirs", a short yardstick handed us 74% of our wins: of 506
 *  single-leg wins only 133 cleared the published number.
 *
 *  A solution we only partly observed is undecidable rather than a win or a
 *  loss — our sum would cover fewer orders than the bar does. */
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
  SELECT o.cow_auction_id AS auction, b.solver AS winner, b.order_hash,
         b.solution_score::numeric AS solution_score,
         b.solution_orders        AS solution_orders
  FROM solution_bids b
  JOIN orders o ON o.order_hash = b.order_hash
  WHERE b.is_winner = 1
    AND o.cow_auction_id IS NOT NULL
    AND o.resolved_at_ms IS NOT NULL
),
bundle AS (
  SELECT auction, winner,
         count(*)             AS legs_tracked,
         max(solution_orders) AS legs_total,
         max(solution_score)  AS bar
  FROM win_bundle GROUP BY 1, 2
),
ours AS (
  -- A zero score is not a cheap bid, it is no bid: scoreOf clamps a delivery
  -- below the user's limit to zero, and a solution containing such a leg is
  -- invalid rather than merely low-scoring. Treating '0' as a legitimate zero
  -- contribution let 15 bundles be won entirely by their sibling leg, every one
  -- of them with our_bid_out at or under the limit we were supposed to beat.
  SELECT w.auction, w.winner,
         CASE WHEN bool_and(o.our_score IS NOT NULL AND o.our_score <> '0')
              THEN sum(COALESCE(NULLIF(o.our_score, ''), '0')::numeric) END AS total
  FROM win_bundle w
  JOIN orders o ON o.order_hash = w.order_hash
  GROUP BY 1, 2
),
verdict AS (
  SELECT w.order_hash, bd.legs_total AS n_orders,
         CASE
           -- No published score, or a solution we only partly observed: our sum
           -- covers a different set of orders than the bar does, so there is no
           -- honest comparison to make. Undecided beats a guess in either
           -- direction, and the win rate is already stated over decided rows.
           WHEN bd.bar IS NULL OR bd.legs_total IS NULL
             OR bd.legs_tracked <> bd.legs_total THEN NULL
           WHEN ou.total IS NULL THEN 0
           WHEN ou.total > bd.bar THEN 1
           ELSE 0
         END AS win
  FROM win_bundle w
  JOIN bundle bd ON bd.auction = w.auction AND bd.winner = w.winner
  JOIN ours ou   ON ou.auction = w.auction AND ou.winner = w.winner
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
