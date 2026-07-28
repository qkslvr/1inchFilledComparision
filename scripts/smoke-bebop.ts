/** Smoke test: Bebop Price API stream. Connects, decodes the protobuf feed,
 *  and resolves the doc ambiguities live: timestamp units, level size units
 *  (base amount vs notional), pair coverage, and update cadence.
 *  Requires BEBOP_API_KEY. Run per chain: `npm run smoke:bebop` /
 *  `CHAIN=ethereum npm run smoke:bebop`. */
import { config, bebopApiKey } from '../config.js';
import { BebopFeed } from '../src/bebop/feed.js';
import { walkSellBaseFloat } from '../src/bebop/depth.js';

if (!bebopApiKey()) {
  console.error('BEBOP_API_KEY not set; add it to .env');
  process.exit(1);
}

const SOAK_MS = Number(process.env.SOAK_MS ?? 20_000);
const feed = new BebopFeed();
await feed.start();

await new Promise((r) => setTimeout(r, SOAK_MS));

console.log(`\nstate=${feed.state} messages=${feed.messageCount} pairs=${feed.books.size} tokens=${feed.decimals.size}`);
if (feed.books.size === 0) {
  console.error('FAIL: no pairs streamed');
  process.exit(1);
}

// find the ETH/USDC-ish pair via our config addresses
const ethPair = config.pairs.find((p) => p.ticker === 'ETH_USDC')!;
const weth = config.wethAddress;
const usdc = ethPair.quote.addresses[0]!;
const found = feed.bookFor(weth, usdc);

console.log('\nsample of streamed pairs:');
let shown = 0;
for (const book of feed.books.values()) {
  if (shown++ >= 8) break;
  const bb = book.bids[0];
  const ba = book.asks[0];
  console.log(
    ` ${book.base.slice(0, 10)}../${book.quote.slice(0, 10)}.. bid=${bb} ask=${ba} ` +
      `levels=${book.bids.length / 2}/${book.asks.length / 2} streamTs=${new Date(book.streamTsMs).toISOString()} ageMs=${Date.now() - book.tsMs}`
  );
}

if (!found) {
  console.error(`FAIL: no WETH/USDC book found (looked for ${weth} vs ${usdc})`);
  process.exit(1);
}
const { book, aIsBase } = found;
console.log(`\nWETH/USDC book: aIsBase=${aIsBase} bids=${book.bids.length / 2} asks=${book.asks.length / 2}`);
const best = aIsBase ? book.bids[0] : book.asks[0];
console.log(`best level price=${best} size=${aIsBase ? book.bids[1] : book.asks[1]}`);

// price plausibility: quote-per-base for ETH/USDC should be in the hundreds-to-tens-of-thousands
if (best === undefined || best < 100 || best > 100_000) {
  console.error(`FAIL: best price ${best} implausible for ETH/USDC; price/size unit assumption is wrong`);
  process.exit(1);
}
// stream timestamp sanity (normalization worked if within 10 min of now)
const skewMs = Math.abs(Date.now() - book.streamTsMs);
console.log(`stream ts skew vs local: ${skewMs}ms ${skewMs > 600_000 ? '(SUSPICIOUS - check units)' : '(ok)'}`);

// depth walk: sell 0.5 ETH
const proceeds = walkSellBaseFloat(aIsBase ? book.bids : book.asks, 0.5);
console.log(`sell 0.5 ETH -> ${proceeds} USDC ${proceeds !== null && proceeds > 100 && proceeds < 50_000 ? '(plausible)' : '(CHECK UNITS)'}`);

feed.stop();
console.log('\nSMOKE OK');
process.exit(0);
