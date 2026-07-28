import assert from 'node:assert/strict';
import test from 'node:test';
import { toPg } from '../src/db/db.js';

/** merge() is private; reach it the way the drain path does. */
const merge = (Reflect.get(
  await import('../src/db/db.js').then((m) => m.Db),
  'merge'
) as (b: Array<{ sql: string; values: unknown[] }>) => Array<{ sql: string; values: unknown[] }>);

const TICK = toPg(`INSERT INTO ticks (order_hash, ts_ms) VALUES (?, ?)`);
const REF = toPg(`INSERT INTO ref_prices (ticker, ts_ms, mid) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`);
const UPD = toPg(`UPDATE orders SET max_edge = ? WHERE order_hash = ?`);

test('merges consecutive inserts sharing a statement', () => {
  const out = merge([
    { sql: TICK, values: ['a', 1] },
    { sql: TICK, values: ['b', 2] },
    { sql: TICK, values: ['c', 3] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.sql, 'INSERT INTO ticks (order_hash, ts_ms) VALUES ($1, $2), ($3, $4), ($5, $6)');
  assert.deepEqual(out[0]!.values, ['a', 1, 'b', 2, 'c', 3]);
});

test('keeps ON CONFLICT after the merged tuples', () => {
  const out = merge([
    { sql: REF, values: ['ETH_USDC', 1, '10'] },
    { sql: REF, values: ['ETH_USDC', 2, '11'] },
  ]);
  assert.equal(out.length, 1);
  assert.match(out[0]!.sql, /VALUES \(\$1, \$2, \$3\), \(\$4, \$5, \$6\) ON CONFLICT DO NOTHING$/);
  assert.deepEqual(out[0]!.values, ['ETH_USDC', 1, '10', 'ETH_USDC', 2, '11']);
});

test('does not merge across different statements, preserving order', () => {
  const out = merge([
    { sql: TICK, values: ['a', 1] },
    { sql: UPD, values: ['5', 'a'] },
    { sql: TICK, values: ['b', 2] },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[1]!.sql, UPD);
});

test('leaves updates alone', () => {
  const out = merge([
    { sql: UPD, values: ['5', 'a'] },
    { sql: UPD, values: ['6', 'b'] },
  ]);
  assert.equal(out.length, 2);
});

test('does not mutate the caller’s value arrays', () => {
  const first = { sql: TICK, values: ['a', 1] };
  merge([first, { sql: TICK, values: ['b', 2] }]);
  assert.deepEqual(first.values, ['a', 1]);
});
