/** Smoke test 4: 1inch Fusion REST on Base — active orders, clock skew,
 *  and rate-limiter spacing (5 queued calls should take ~4s at 1 rps after burst). */
import { FusionClient } from '../src/fusion/client.js';
import { config, pairForTokens } from '../config.js';

const client = new FusionClient();

const res = await client.getActiveOrders(1, 100);
console.log(`active orders on ${config.chainLabel}: totalItems=${res.meta.totalItems}, page has ${res.items.length}`);
console.log(`clock skew (local - server): ${client.skewMs === null ? 'unknown' : -client.skewMs + 'ms'}`);

let supported = 0;
for (const o of res.items) {
  const m = pairForTokens(o.order.makerAsset, o.order.takerAsset);
  if (m) supported++;
}
console.log(`of ${res.items.length} on this page, ${supported} map to a KalqiX pair`);

const sample = res.items[0];
if (sample) {
  console.log('sample order:', {
    orderHash: sample.orderHash,
    makerAsset: sample.order.makerAsset,
    takerAsset: sample.order.takerAsset,
    makingAmount: sample.order.makingAmount,
    takingAmount: sample.order.takingAmount,
    auctionStartDate: sample.auctionStartDate,
    auctionEndDate: sample.auctionEndDate,
    remainingMakerAmount: sample.remainingMakerAmount,
    deadline: sample.deadline,
    version: sample.version,
    extensionLen: sample.extension.length,
  });
}

console.log('\nrate limiter spacing check (5 sequential calls):');
const t0 = Date.now();
const stamps: number[] = [];
await Promise.all(
  Array.from({ length: 5 }, () =>
    client.limiter.schedule(async () => {
      stamps.push(Date.now() - t0);
    })
  )
);
console.log(`dispatch offsets ms: ${stamps.join(', ')}`);
const elapsed = stamps[stamps.length - 1]!;
if (elapsed < 1500) {
  console.error(`FAIL: 5 calls dispatched in ${elapsed}ms — limiter not throttling (expect ~2s+ with burst 3 @ 1 rps)`);
  process.exit(1);
}
console.log('SMOKE OK');
