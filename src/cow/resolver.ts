/** cowswapResolver — did the winning CoW solver leave money on the table?
 *
 *  For every settled CoW trade, ask what KalqiX, Kyber and Bebop would have paid
 *  the same user for the same sell amount. A positive edge means a rival venue
 *  beat the price the solver actually delivered.
 *
 *  This is a price comparison and nothing more. CoW's open-order set is
 *  solver-only, so we never see an order in flight and cannot ask who would have
 *  been first. `t_actual_*` is left null so classify() reports no lead time
 *  rather than inventing one. See SPEC-cowswap-resolver.md.
 */
import { config, pairForTokens } from '../../config.js';
import { Db, type TickInsert } from '../db/db.js';
import { GasPoller } from '../gas/poller.js';
import { RefPriceLoop, Sampler } from '../kalqix/sampler.js';
import { chooseBookFetcher } from '../kalqix/client.js';
import { fetchKyberQuote } from '../kyber/client.js';
import { BebopFeed } from '../bebop/feed.js';
import { walkBuyBaseFloat, walkSellBaseFloat } from '../bebop/depth.js';
import { walkBuyBase, walkSellBase } from '../kalqix/book.js';
import { SettlementFeed, type CowTrade } from './settlements.js';
import { bpsOfCeil, ppmOfCeil, quoteForBaseCeil, rescale, toFloat } from '../pricing/units.js';
import { buildDecidedOutcome, OUTCOME_ORDER_SQL, OUTCOME_TICK_SQL } from '../report/outcome.js';
import { NATIVE_SENTINEL } from '../../config.js';
import { log, logError } from '../log.js';

const SDK_VERSION = 'cow-settlements-1';

const db = await Db.open(config.chainId, { schemaOverride: config.schemaOverride });
const runId = await db.startRun(
  JSON.stringify(config, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  process.version,
  SDK_VERSION
);
log(`run ${runId} starting: ${config.chainLabel}, schema ${config.schemaOverride}`);

const gas = new GasPoller(
  (s) => db.insertGasSample(s.tsMs, s.gasPriceWei, s.baseFeeWei),
  () => db.event(runId, 'rpc_error', { source: 'gas_poll' })
);
const refPrices = new RefPriceLoop(db);
const bebop = new BebopFeed((kind) => db.event(runId, kind, {}));
const { fetcher: bookFetcher } = config.hasKalqix
  ? await chooseBookFetcher(log)
  : { fetcher: undefined };
// Unlike the Fusion collector these run continuously rather than only while an
// order is live: a settlement arrives without warning and the book has to
// already be there to price it.
const samplers = new Map<string, Sampler>(
  config.pairs.filter((p) => p.kalqix).map((p) => [p.ticker, new Sampler(p, db, () => runId, bookFetcher)])
);
await gas.start();
await refPrices.start();
await bebop.start();
for (const s of samplers.values()) s.setActive(true);

const wethFor = (a: string) => (a.toLowerCase() === NATIVE_SENTINEL ? config.wethAddress : a.toLowerCase());

/** Value a wei amount in the token the user is paid in, so gas is subtracted in
 *  the same units as the proceeds. */
function weiToBuyToken(wei: bigint, buyDecimals: number, buySymbol: string): bigint | null {
  if (buySymbol === config.nativeSymbol) return wei;
  const mid = refPrices.latestMid.get(config.nativeTicker);
  if (mid === undefined) return null;
  const inStable = quoteForBaseCeil(wei, mid.mid, 18);
  return rescale(inStable, 6, buyDecimals);
}

let evaluated = 0;
let skipped = 0;

async function evaluate(trade: CowTrade): Promise<void> {
  if (await db.orderExists(trade.orderUid)) return;
  const sellToken = wethFor(trade.sellToken);
  const buyToken = wethFor(trade.buyToken);
  const match = pairForTokens(sellToken, buyToken);
  if (!match) {
    skipped++;
    return; // not a pair we can hedge; recorded only as volume below
  }
  const { pair, direction } = match;
  const buyDecimals = direction === 'SELL_BASE' ? pair.quote.decimals : pair.base.decimals;
  const buySymbol = direction === 'SELL_BASE' ? pair.quote.symbol : pair.base.symbol;

  await db.insertOrder({
    orderHash: trade.orderUid,
    runId,
    receivedAtMs: trade.blockTsMs,
    source: 'poll',
    lateSeen: false,
    makerAsset: sellToken,
    takerAsset: buyToken,
    makingAmount: trade.sellAmount,
    takingAmount: trade.buyAmount,
    remainingMaker: trade.sellAmount,
    makerAddress: trade.owner,
    pair: pair.ticker,
    direction,
    hedgeAssetKind: null,
    eligible: true,
    kyberOnly: false,
    skipReason: null,
    sizeUsd: null,
    auctionStartMs: null,
    auctionDurationS: null,
    initialRateBump: null,
    auctionPointsJson: null,
    gasBumpEstimate: null,
    gasPriceEstimate: null,
    allowPartialFills: null,
    allowMultipleFills: null,
    deadlineMs: null,
    extensionRaw: null,
    orderStructJson: null,
  });

  const gasNow = gas.latest;
  const gasPriceWei = gasNow?.gasPriceWei ?? 0n;
  const gasCostRaw = weiToBuyToken(config.gasUnits * gasPriceWei, buyDecimals, buySymbol) ?? 0n;
  // buyAmount replaces auctionCost: it is what the user must be paid, and unlike
  // a Dutch auction it does not decay.
  const cost = trade.buyAmount;
  const quoteLagMs = Date.now() - trade.blockTsMs;

  // --- KalqiX ---
  let hedgeProceeds: bigint | null = null;
  let insufficientDepth = false;
  let feeCost: bigint | null = null;
  const snap = samplers.get(pair.ticker)?.latest ?? null;
  if (snap) {
    const walk =
      direction === 'SELL_BASE'
        ? walkSellBase(snap.book.bids, trade.sellAmount, pair.base.decimals)
        : walkBuyBase(snap.book.asks, trade.sellAmount, pair.base.decimals);
    hedgeProceeds = walk.proceeds;
    insufficientDepth = walk.proceeds === null;
    if (hedgeProceeds !== null) feeCost = ppmOfCeil(hedgeProceeds, config.kalqixTakerFeeBps * 100n);
  }

  // --- Kyber ---
  let kyberOut: bigint | null = null;
  let kyberGasCost: bigint | null = null;
  let kyberFee: bigint | null = null;
  let edgeKyber: bigint | null = null;
  try {
    const q = await fetchKyberQuote(sellToken, buyToken, trade.sellAmount);
    kyberOut = q.amountOut;
    kyberGasCost = weiToBuyToken(q.gasUnits * gasPriceWei, buyDecimals, buySymbol);
    kyberFee = bpsOfCeil(kyberOut, config.kyber.feeBps);
    if (kyberGasCost !== null) {
      edgeKyber = kyberOut - cost - gasCostRaw - kyberGasCost - kyberFee - bpsOfCeil(cost, config.safetyMarginBps);
    }
  } catch (err) {
    logError(`kyber quote failed for ${trade.orderUid.slice(0, 12)}`, err);
  }

  // --- Bebop ---
  let bebopOut: bigint | null = null;
  let bebopGasCost: bigint | null = null;
  let bebopFee: bigint | null = null;
  let edgeBebop: bigint | null = null;
  if (bebop.enabled) {
    const found = bebop.bookFor(sellToken, buyToken);
    if (found) {
      const sellDecimals = direction === 'SELL_BASE' ? pair.base.decimals : pair.quote.decimals;
      const human = toFloat(trade.sellAmount, sellDecimals);
      const out = found.aIsBase ? walkSellBaseFloat(found.book.bids, human) : walkBuyBaseFloat(found.book.asks, human);
      if (out !== null && out > 0) {
        bebopOut = BigInt(Math.floor(out * 10 ** Math.min(buyDecimals, 12))) * 10n ** BigInt(Math.max(0, buyDecimals - 12));
        bebopFee = bpsOfCeil(bebopOut, config.bebop.feeBps);
        bebopGasCost = weiToBuyToken(config.bebop.gasUnits * gasPriceWei, buyDecimals, buySymbol);
        if (bebopGasCost !== null) {
          edgeBebop = bebopOut - cost - gasCostRaw - bebopGasCost - bebopFee - bpsOfCeil(cost, config.safetyMarginBps);
        }
      }
    }
  }

  const edgeDefault =
    hedgeProceeds !== null && feeCost !== null
      ? hedgeProceeds - cost - gasCostRaw - feeCost - bpsOfCeil(cost, config.safetyMarginBps)
      : null;

  const tick: TickInsert = {
    orderHash: trade.orderUid,
    // The instant being evaluated is the settling block; the lag before we could
    // quote is carried in snapshotAgeMs and flagged as degraded when large.
    tsMs: trade.blockTsMs,
    snapshotId: snap?.id ?? null,
    snapshotAgeMs: quoteLagMs,
    degraded: quoteLagMs > config.degradedSnapshotAgeMs,
    exclusive: false,
    remainingMaker: trade.sellAmount,
    rateBump: null,
    insufficientDepth,
    hedgeProceeds,
    auctionCost: cost,
    gasCostRaw,
    baseFeeWei: gasNow?.baseFeeWei ?? null,
    gasPriceWei: gasNow ? gasPriceWei : null,
    feeCost,
    notionalTaker: cost,
    notionalUsdc:
      buySymbol === config.stableSymbol ? rescale(cost, buyDecimals, 6) : null,
    edgeDefault,
    partialBestQty: null,
    partialBestEdge: null,
    kyberOut,
    kyberAmountIn: trade.sellAmount,
    kyberQuoteAgeMs: quoteLagMs,
    kyberDegraded: quoteLagMs > config.kyber.degradedQuoteAgeMs,
    kyberGasCost,
    kyberFee,
    edgeKyber,
    bebopOut,
    bebopAgeMs: quoteLagMs,
    bebopDegraded: quoteLagMs > config.bebop.degradedAgeMs,
    bebopGasCost,
    bebopFee,
    edgeBebop,
    pancakeOut: null,
    pancakeAgeMs: null,
    pancakeDegraded: null,
    pancakeGasCost: null,
    pancakeFee: null,
    pancakeTier: null,
    edgePancake: null,
  };
  db.insertTick(tick);
  // Settled by definition. terminal_at_ms sits one ms after the tick so the tick
  // falls inside classify()'s decision horizon; t_actual stays null so no lead
  // time is reported.
  db.setTerminal(trade.orderUid, 'filled', null, trade.sellAmount, trade.buyAmount);
  await db.all(`UPDATE orders SET terminal_at_ms = ? WHERE order_hash = ?`, [
    trade.blockTsMs + 1,
    trade.orderUid,
  ]);

  const row = await db.get(OUTCOME_ORDER_SQL, [trade.orderUid]);
  if (row) {
    const raw = await db.all(OUTCOME_TICK_SQL, [trade.orderUid]);
    db.upsertDecidedOutcome(buildDecidedOutcome(row, raw));
  }
  evaluated++;
}

const feed = new SettlementFeed((t) => {
  void evaluate(t).catch((err) => logError(`evaluate ${t.orderUid.slice(0, 12)} failed`, err));
});
await feed.start();

const status = setInterval(() => {
  log(
    `status: trades=${feed.tradeCount} evaluated=${evaluated} unhedgeable=${skipped} ` +
      `bebop=${bebop.enabled ? `${bebop.state}/${bebop.books.size}pairs` : 'off'} ` +
      `books=${[...samplers.values()].map((s) => `${s.ticker}=${s.sampleCount}`).join(' ')}` +
      (db.storagePressure ? ` STORAGE-PRESSURE(${db.droppedTicks} dropped)` : '')
  );
}, 60_000);

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log('SIGINT: shutting down...');
  feed.stop();
  bebop.stop();
  for (const s of samplers.values()) s.stop();
  refPrices.stop();
  gas.stop();
  clearInterval(status);
  setTimeout(() => {
    void (async () => {
      db.endRun(runId, true);
      await db.close();
      log('shutdown complete');
      process.exit(0);
    })();
  }, 500);
});
process.on('SIGTERM', () => process.emit('SIGINT'));

log('cowswapResolver running (Ctrl+C to stop)');
