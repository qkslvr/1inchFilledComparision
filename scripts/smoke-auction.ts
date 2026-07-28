/** Smoke test 5: decode a live order's extension locally and print its cost curve.
 *  Verifies FusionOrder.fromDataAndExtension + AuctionDetails.fromExtension against
 *  real Base Fusion orders, and that the all-in cost decays toward takingAmount. */
import { FusionClient } from '../src/fusion/client.js';
import { costAt, decodeOrder, isExclusiveAt, rateBumpAt } from '../src/fusion/auction.js';

const client = new FusionClient();
const res = await client.getActiveOrders(1, 50);
if (res.items.length === 0) {
  console.log('no active orders on Base right now; rerun later');
  process.exit(0);
}

let decoded = 0;
for (const o of res.items) {
  try {
    const d = decodeOrder(o.order, o.extension);
    decoded++;
    if (decoded === 1) {
      console.log('order', o.orderHash);
      console.log({
        auctionStart: new Date(d.auctionStartMs).toISOString(),
        durationS: d.auctionDurationS,
        initialRateBump: d.initialRateBump,
        points: JSON.parse(d.pointsJson),
        gasBumpEstimate: d.gasBumpEstimate.toString(),
        gasPriceEstimate: d.gasPriceEstimate.toString(),
        allowPartialFills: d.allowPartialFills,
        allowMultipleFills: d.allowMultipleFills,
        deadline: new Date(d.deadlineMs).toISOString(),
      });
      const remaining = BigInt(o.remainingMakerAmount);
      const startS = BigInt(Math.floor(d.auctionStartMs / 1000));
      const endS = startS + BigInt(d.auctionDurationS);
      const midS = (startS + endS) / 2n;
      const takingAmount = BigInt(o.order.takingAmount);
      const at = (t: bigint, label: string) => {
        const cost = costAt(d, remaining, t, 0n);
        console.log(
          `${label} t=${t}: rateBump=${rateBumpAt(d, t, 0n)} cost=${cost} exclusive=${isExclusiveAt(d, t)}`
        );
        return cost;
      };
      const cStart = at(startS, 'start');
      const cMid = at(midS, 'mid  ');
      const cEnd = at(endS, 'end  ');
      console.log(`order takingAmount=${takingAmount} remaining=${remaining}`);
      if (!(cStart >= cMid && cMid >= cEnd)) {
        console.error('FAIL: cost curve not non-increasing');
        process.exit(1);
      }
      if (remaining === BigInt(o.order.makingAmount) && cEnd < takingAmount) {
        console.error('FAIL: end-of-auction cost below base takingAmount');
        process.exit(1);
      }
    }
  } catch (err) {
    console.log(`decode failed for ${o.orderHash}: ${(err as Error).message}`);
  }
}
console.log(`\ndecoded ${decoded}/${res.items.length} active orders`);
if (decoded === 0) {
  console.error('FAIL: could not decode any order extension');
  process.exit(1);
}
console.log('SMOKE OK');
