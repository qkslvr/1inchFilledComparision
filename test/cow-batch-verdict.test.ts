import assert from 'node:assert/strict';
import test from 'node:test';
import { recomputeBatchVerdicts } from '../src/cow/batchverdict.js';

/** A stand-in for Db that runs the verdict SQL against in-memory tables.
 *
 *  The rule is expressed in SQL, so a test that reimplemented it in TypeScript
 *  would pass while the shipped statement was wrong. Instead this drives the
 *  real `recomputeBatchVerdicts` and only fakes the rows underneath it. */
interface Order { order_hash: string; auction: number; our_score: bigint | null; won: number;
  batch_won?: number | null; batch_size?: number | null }
interface Bid { order_hash: string; solver: string; is_winner: number; score: bigint }

function fakeDb(orders: Order[], bids: Bid[]) {
  return {
    async all(sql: string): Promise<any[]> {
      if (sql.includes('SELECT order_hash, won FROM orders')) {
        return orders.map((o) => ({ order_hash: o.order_hash, won: o.won }));
      }
      if (sql.trimStart().startsWith('WITH bundle_totals')) {
        // The rule, applied exactly as the SQL states it.
        for (const b of bids.filter((x) => x.is_winner === 1)) {
          const self = orders.find((o) => o.order_hash === b.order_hash)!;
          const bundle = bids.filter(
            (x) =>
              x.is_winner === 1 &&
              x.solver === b.solver &&
              orders.find((o) => o.order_hash === x.order_hash)?.auction === self.auction
          );
          const rows = bundle.map((x) => orders.find((o) => o.order_hash === x.order_hash)!);
          const theirs = bundle.reduce((a, x) => a + x.score, 0n);
          const complete = rows.every((r) => r.our_score !== null);
          const ours = complete ? rows.reduce((a, r) => a + r.our_score!, 0n) : null;
          self.batch_won = ours !== null && ours > theirs ? 1 : 0;
          self.batch_size = bundle.length;
        }
        return [];
      }
      return orders
        .filter((o) => o.batch_won !== undefined && o.batch_won !== null)
        .map((o) => ({ order_hash: o.order_hash, batch_won: o.batch_won, batch_size: o.batch_size }));
    },
  } as any;
}

test('winning one leg of a two-order batch is not a win', async () => {
  // The exact shape that produced 61 impossible results: we beat them on A by a
  // lot less than they beat us on B, but the per-order column called A a win.
  const orders: Order[] = [
    { order_hash: 'A', auction: 1, our_score: 110n, won: 1 },
    { order_hash: 'B', auction: 1, our_score: 10n, won: 0 },
  ];
  const bids: Bid[] = [
    { order_hash: 'A', solver: 'rival', is_winner: 1, score: 100n },
    { order_hash: 'B', solver: 'rival', is_winner: 1, score: 100n },
  ];
  const s = await recomputeBatchVerdicts(fakeDb(orders, bids));
  assert.equal(orders[0]!.batch_won, 0, 'A must lose: 120 total against their 200');
  assert.equal(orders[1]!.batch_won, 0);
  assert.equal(s.demoted, 1, 'the per-order win on A should be demoted');
});

test('a narrow loss on one leg is survivable if the other leg carries it', async () => {
  // The recount is not a filter. Bundled totals can rescue a leg we lost.
  const orders: Order[] = [
    { order_hash: 'A', auction: 1, our_score: 500n, won: 1 },
    { order_hash: 'B', auction: 1, our_score: 90n, won: 0 },
  ];
  const bids: Bid[] = [
    { order_hash: 'A', solver: 'rival', is_winner: 1, score: 100n },
    { order_hash: 'B', solver: 'rival', is_winner: 1, score: 100n },
  ];
  const s = await recomputeBatchVerdicts(fakeDb(orders, bids));
  assert.equal(orders[0]!.batch_won, 1, '590 beats 200 over the bundle');
  assert.equal(orders[1]!.batch_won, 1, 'and B rides along, because it is one solution');
  assert.equal(s.promoted, 1, 'B was a per-order loss and is now a bundle win');
});

test('a bundle we cannot fully cover is a loss, not a partial credit', async () => {
  // No score on B means we could not have submitted that solution at all.
  const orders: Order[] = [
    { order_hash: 'A', auction: 1, our_score: 10_000n, won: 1 },
    { order_hash: 'B', auction: 1, our_score: null, won: 0 },
  ];
  const bids: Bid[] = [
    { order_hash: 'A', solver: 'rival', is_winner: 1, score: 1n },
    { order_hash: 'B', solver: 'rival', is_winner: 1, score: 1n },
  ];
  await recomputeBatchVerdicts(fakeDb(orders, bids));
  assert.equal(orders[0]!.batch_won, 0, 'an uncoverable bundle cannot be won');
});

test('a single-order auction still decides exactly as it did before', async () => {
  const orders: Order[] = [
    { order_hash: 'A', auction: 1, our_score: 101n, won: 1 },
    { order_hash: 'C', auction: 2, our_score: 99n, won: 0 },
  ];
  const bids: Bid[] = [
    { order_hash: 'A', solver: 'rival', is_winner: 1, score: 100n },
    { order_hash: 'C', solver: 'rival', is_winner: 1, score: 100n },
  ];
  const s = await recomputeBatchVerdicts(fakeDb(orders, bids));
  assert.equal(orders[0]!.batch_won, 1);
  assert.equal(orders[1]!.batch_won, 0);
  assert.equal(orders[0]!.batch_size, 1);
  assert.equal(s.demoted + s.promoted, 0, 'unbundled orders must not move');
});

test('a tie loses, because ranking above the winner requires beating it', async () => {
  const orders: Order[] = [{ order_hash: 'A', auction: 1, our_score: 100n, won: 0 }];
  const bids: Bid[] = [{ order_hash: 'A', solver: 'rival', is_winner: 1, score: 100n }];
  await recomputeBatchVerdicts(fakeDb(orders, bids));
  assert.equal(orders[0]!.batch_won, 0);
});
