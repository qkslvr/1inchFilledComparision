/** Smoke test 2: live KalqiX books + hard verification of the price-scaling
 *  assumption (price = quote base units per whole base unit). Aborts loudly on
 *  failure — everything downstream builds on this interpretation. */
import { config } from '../config.js';
import { fetchMyFees, fetchOrderBook, fetchOrderBookAuthed } from '../src/kalqix/client.js';
import { kalqixCreds } from '../src/kalqix/auth.js';
import { bestAsk, bestBid, depthBase, mid, walkBuyBase, walkSellBase } from '../src/kalqix/book.js';
import { fmtUnits, pow10, toFloat } from '../src/pricing/units.js';

const PLAUSIBLE_MID_USDC: Record<string, [number, number]> = {
  ETH_USDC: [500, 50_000],
  cbBTC_USDC: [10_000, 500_000],
};

let failed = false;

for (const pair of config.pairs) {
  const { ticker, base, quote } = pair;
  console.log(`\n=== ${ticker} (base ${base.symbol}/${base.decimals}dp, quote ${quote.symbol}/${quote.decimals}dp) ===`);
  const { book, fetchMs } = await fetchOrderBook(ticker, config.bookDepth);
  console.log(`fetched in ${fetchMs}ms: ${book.bids.length} bids, ${book.asks.length} asks`);

  const bb = bestBid(book);
  const ba = bestAsk(book);
  const m = mid(book);
  if (bb === null || ba === null || m === null) {
    console.error(`FAIL: one-sided or empty book, cannot verify scaling`);
    failed = true;
    continue;
  }
  console.log(`best bid ${fmtUnits(bb, quote.decimals)} ${quote.symbol}, best ask ${fmtUnits(ba, quote.decimals)}, mid ${fmtUnits(m, quote.decimals)}`);
  console.log(`top-${config.bookDepth} depth: ${fmtUnits(depthBase(book.bids), base.decimals)} ${base.symbol} bid side, ${fmtUnits(depthBase(book.asks), base.decimals)} ${base.symbol} ask side`);

  const midFloat = toFloat(m, quote.decimals);
  const range = PLAUSIBLE_MID_USDC[ticker];
  if (!range) throw new Error(`no plausibility band for ${ticker}`);
  const [lo, hi] = range;
  if (midFloat < lo || midFloat > hi) {
    console.error(`FAIL: mid ${midFloat} ${quote.symbol} outside plausible band [${lo}, ${hi}] — price scaling assumption is WRONG, do not proceed`);
    failed = true;
    continue;
  }
  console.log(`price scaling OK: mid ${midFloat.toFixed(2)} ${quote.symbol} within [${lo}, ${hi}]`);

  if (ba <= bb) {
    console.error(`FAIL: crossed book (ask <= bid) — side interpretation is wrong`);
    failed = true;
    continue;
  }

  const sellQty = pow10(base.decimals); // 1 whole base unit
  const sell = walkSellBase(book.bids, sellQty, base.decimals);
  console.log(
    sell.proceeds !== null
      ? `sell 1 ${base.symbol} -> ${fmtUnits(sell.proceeds, quote.decimals)} ${quote.symbol}`
      : `sell 1 ${base.symbol}: INSUFFICIENT DEPTH (absorbed ${fmtUnits(sell.consumed, base.decimals)})`
  );

  const spend = 2000n * pow10(quote.decimals); // 2000 USDC
  const buy = walkBuyBase(book.asks, spend, base.decimals);
  console.log(
    buy.proceeds !== null
      ? `buy with 2000 ${quote.symbol} -> ${fmtUnits(buy.proceeds, base.decimals)} ${base.symbol}`
      : `buy with 2000 ${quote.symbol}: INSUFFICIENT DEPTH (spent ${fmtUnits(buy.consumed, quote.decimals)})`
  );

  if (sell.proceeds !== null) {
    const implied = toFloat(sell.proceeds, quote.decimals);
    if (Math.abs(implied - midFloat) / midFloat > 0.1) {
      console.error(`FAIL: selling 1 ${base.symbol} yields ${implied} ${quote.symbol}, >10% away from mid ${midFloat} — depth-walk arithmetic suspect`);
      failed = true;
    }
  }
}

if (kalqixCreds()) {
  console.log('\n=== authenticated endpoints ===');
  try {
    const fees = await fetchMyFees();
    console.log(`effective fees: taker ${fees.takerPpm} ppm (${Number(fees.takerPpm) / 100} bps), maker ${fees.makerPpm} ppm, tier ${fees.tier}`);
  } catch (err) {
    console.error(`FAIL: fee fetch failed: ${(err as Error).message}`);
    failed = true;
  }
  try {
    const authed = await fetchOrderBookAuthed('ETH_USDC', 100);
    const pub = await fetchOrderBook('ETH_USDC', 100);
    console.log(
      `authed book: ${authed.book.bids.length} bids / ${authed.book.asks.length} asks ` +
        `(public: ${pub.book.bids.length} / ${pub.book.asks.length})`
    );
    const am = mid(authed.book);
    const pm = mid(pub.book);
    if (am !== null && pm !== null && Number(am > pm ? am - pm : pm - am) / Number(pm) > 0.05) {
      console.error('FAIL: authed and public mids differ by more than 5 percent');
      failed = true;
    }
  } catch (err) {
    console.error(`authed book probe failed (collector will fall back to public): ${(err as Error).message}`);
  }
} else {
  console.log('\nKALQIX_API_KEY / KALQIX_API_SECRET not set; skipping authed checks');
}

if (failed) {
  console.error('\nSMOKE FAILED');
  process.exit(1);
}
console.log('\nSMOKE OK');
