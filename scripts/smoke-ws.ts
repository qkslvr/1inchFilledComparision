/** Smoke test 6: 5-minute WS soak on Base. Logs every event envelope.
 *  To exercise reconnect, briefly kill the network mid-run and watch the
 *  backoff + reconnect log lines. */
import { FusionFeed } from '../src/fusion/ws.js';
import { pairForTokens } from '../config.js';
import { log } from '../src/log.js';

const SOAK_MS = Number(process.env.SOAK_MS ?? 5 * 60 * 1000);

let created = 0;
let filled = 0;
let other = 0;

const feed = new FusionFeed({
  onOrderCreated(p) {
    created++;
    const mapped = pairForTokens(p.order.makerAsset, p.order.takerAsset);
    log(
      `order_created ${p.orderHash} ${p.order.makerAsset} -> ${p.order.takerAsset}` +
        ` making=${p.order.makingAmount} ${mapped ? `[${mapped.pair.ticker} ${mapped.direction}]` : '[unsupported]'}`
    );
  },
  onOrderFilled(hash) {
    filled++;
    log(`order_filled ${hash}`);
  },
  onOrderFilledPartially(hash, remaining) {
    filled++;
    log(`order_filled_partially ${hash} remaining=${remaining}`);
  },
  onOrderCancelled(hash) {
    other++;
    log(`order_cancelled ${hash}`);
  },
  onOrderInvalid(hash) {
    other++;
    log(`order_invalid ${hash}`);
  },
  onBalanceChange(hash, remaining) {
    other++;
    log(`balance_change ${hash} remaining=${remaining}`);
  },
  onStateChange(connected) {
    log(`ws state: ${connected ? 'CONNECTED' : 'DISCONNECTED'}`);
  },
});

feed.start();
log(`soaking for ${SOAK_MS / 1000}s...`);
setTimeout(() => {
  feed.stop();
  log(`done: ${created} created, ${filled} fill events, ${other} other events`);
  process.exit(0);
}, SOAK_MS);
