import assert from 'node:assert/strict';
import test from 'node:test';
import { recomputeBatchVerdicts } from '../src/cow/batchverdict.js';

/** A stand-in for Db that runs the verdict rule against in-memory rows.
 *
 *  The rule lives in SQL, so a test that reimplemented it in TypeScript would
 *  pass while the shipped statement was wrong. This drives the real
 *  `recomputeBatchVerdicts` and only fakes the rows underneath it. */
interface Order { order_hash: string; auction: number; our_score: bigint | null; won: number;
  batch_won?: number | null; batch_size?: number | null }
interface Bid { order_hash: string; solver: string; is_winner: number;
  solution_score: bigint | null; solution_orders: number | null }

function fakeDb(orders: Order[], bids: Bid[]) {
  return {
    async all(sql: string): Promise<any[]> {
      if (sql.includes('SELECT order_hash, won FROM orders')) {
        return orders.map((o) => ({ order_hash: o.order_hash, won: o.won }));
      }
      if (sql.trimStart().startsWith('WITH win_bundle')) {
        for (const b of bids.filter((x) => x.is_winner === 1)) {
          const self = orders.find((o) => o.order_hash === b.order_hash)!;
          const set = bids.filter(
            (x) =>
              x.is_winner === 1 &&
              x.solver === b.solver &&
              orders.find((o) => o.order_hash === x.order_hash)?.auction === self.auction
          );
          const legsTracked = set.length;
          const legsTotal = Math.max(...set.map((x) => x.solution_orders ?? -Infinity));
          const bar = set.map((x) => x.solution_score).find((x) => x !== null) ?? null;
          const rows = set.map((x) => orders.find((o) => o.order_hash === x.order_hash)!);
          const ours = rows.every((r) => r.our_score !== null)
            ? rows.reduce((a, r) => a + r.our_score!, 0n)
            : null;

          self.batch_size = Number.isFinite(legsTotal) ? legsTotal : null;
          if (bar === null || !Number.isFinite(legsTotal) || legsTracked !== legsTotal) {
            self.batch_won = null;
          } else if (ours === null) {
            self.batch_won = 0;
          } else {
            self.batch_won = ours > bar ? 1 : 0;
          }
        }
        return [];
      }
      return orders
        .filter((o) => o.batch_won !== undefined && o.batch_won !== null)
        .map((o) => ({ order_hash: o.order_hash, batch_won: o.batch_won, batch_size: o.batch_size }));
    },
  } as any;
}

const bid = (h: string, solver: string, score: bigint | null, legs: number | null): Bid =>
  ({ order_hash: h, solver, is_winner: 1, solution_score: score, solution_orders: legs });

test('the bar is the score CoW published, not one we rebuild', async () => {
  // Rebuilding the winner's score from the amounts it delivered ran short, and
  // the gap decided auctions our way: of 506 single-leg wins only 133 cleared
  // the published number. 100 would have beaten a reconstruction of 90.
  const orders: Order[] = [{ order_hash: 'A', auction: 1, our_score: 100n, won: 1 }];
  await recomputeBatchVerdicts(fakeDb(orders, [bid('A', 'w', 110n, 1)]));
  assert.equal(orders[0]!.batch_won, 0, 'must lose against the published 110');
});

test('clearing the published score is a win', async () => {
  const orders: Order[] = [{ order_hash: 'A', auction: 1, our_score: 120n, won: 1 }];
  await recomputeBatchVerdicts(fakeDb(orders, [bid('A', 'w', 110n, 1)]));
  assert.equal(orders[0]!.batch_won, 1);
});

test('a tie loses, because outranking the winner means beating it', async () => {
  const orders: Order[] = [{ order_hash: 'A', auction: 1, our_score: 110n, won: 1 }];
  await recomputeBatchVerdicts(fakeDb(orders, [bid('A', 'w', 110n, 1)]));
  assert.equal(orders[0]!.batch_won, 0);
});

test('a bundle is judged on its total, all legs at once', async () => {
  // A leg lost narrowly can still be carried by the rest — the solution settles
  // whole, so the sum is the thing that has to clear the bar.
  const orders: Order[] = [
    { order_hash: 'A', auction: 1, our_score: 500n, won: 1 },
    { order_hash: 'B', auction: 1, our_score: 90n, won: 0 },
  ];
  const bids = [bid('A', 'w', 400n, 2), bid('B', 'w', 400n, 2)];
  await recomputeBatchVerdicts(fakeDb(orders, bids));
  assert.equal(orders[0]!.batch_won, 1, '590 clears the published 400');
  assert.equal(orders[1]!.batch_won, 1, 'and B rides along, because it is one solution');
});

test('a solution we only partly observed is undecidable, not a win', async () => {
  // The published score covers three legs; we hold one. Our sum and the bar
  // describe different trades, so there is no honest comparison to make.
  const orders: Order[] = [{ order_hash: 'A', auction: 1, our_score: 10_000n, won: 1 }];
  await recomputeBatchVerdicts(fakeDb(orders, [bid('A', 'w', 100n, 3)]));
  assert.equal(orders[0]!.batch_won, null, 'one leg of three cannot be judged');
});

test('no published score means no verdict', async () => {
  const orders: Order[] = [{ order_hash: 'A', auction: 1, our_score: 10_000n, won: 1 }];
  await recomputeBatchVerdicts(fakeDb(orders, [bid('A', 'w', null, 1)]));
  assert.equal(orders[0]!.batch_won, null);
});

test('a leg we could not price is a loss, not partial credit', async () => {
  // No score on B means we could not have submitted that solution at all.
  const orders: Order[] = [
    { order_hash: 'A', auction: 1, our_score: 10_000n, won: 1 },
    { order_hash: 'B', auction: 1, our_score: null, won: 0 },
  ];
  const bids = [bid('A', 'w', 1n, 2), bid('B', 'w', 1n, 2)];
  await recomputeBatchVerdicts(fakeDb(orders, bids));
  assert.equal(orders[0]!.batch_won, 0, 'an uncoverable solution cannot be won');
});
