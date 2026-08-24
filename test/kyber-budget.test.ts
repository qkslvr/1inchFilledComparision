import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestBudget } from '../src/kyber/budget.js';

test('spends up to the capacity, then refuses', () => {
  const b = new RequestBudget(5, 10_000);
  for (let i = 0; i < 5; i++) assert.equal(b.take(), true, `request ${i} should be granted`);
  assert.equal(b.take(), false, 'the sixth exceeds the budget');
  assert.equal(b.granted, 5);
  assert.equal(b.denied, 1);
});

test('refills continuously rather than resetting in a burst', async () => {
  // A window reset would let the whole allowance be spent the instant it rolls
  // over, which is exactly the burst the limit exists to stop.
  const b = new RequestBudget(10, 200); // 10 per 200ms = 1 per 20ms
  for (let i = 0; i < 10; i++) b.take();
  assert.equal(b.take(), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(b.take(), true, 'partial elapsed time should grant partial budget');
  // but not the whole allowance back
  let granted = 1;
  while (b.take()) granted++;
  assert.ok(granted < 10, `expected a partial refill, got ${granted}`);
});

test('never banks more than the capacity while idle', async () => {
  const b = new RequestBudget(3, 50);
  await new Promise((r) => setTimeout(r, 300)); // six windows of idling
  let granted = 0;
  while (b.take()) granted++;
  assert.equal(granted, 3, 'idle time must not accumulate into a burst');
});

test('a fresh budget is immediately usable', () => {
  assert.equal(new RequestBudget(1, 1000).take(), true);
});
