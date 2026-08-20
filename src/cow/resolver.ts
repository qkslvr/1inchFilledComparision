/** cowswapResolver — did the winning CoW solver leave money on the table?
 *
 *  For every CoW trade, ask what KalqiX, Kyber and Bebop would have paid the same
 *  user for the same sell amount. A positive edge means a rival venue beat the
 *  price the solver actually delivered.
 *
 *  Two feeds supply the same trades from different angles:
 *
 *    - CompetitionFeed reads the public solver-competition endpoint, which
 *      names the winning solution at the block the auction was decided. This is
 *      the primary source: quoting against that block removes the settlement lag
 *      that used to contaminate the measurement.
 *    - SettlementFeed reads `Trade` logs after the fact. Kept as a backstop, so
 *      an auction missed during a restart or an API outage is still recorded.
 *
 *  Whichever arrives first wins; `orders.source` records which, so the two can
 *  be reconciled. It remains a price comparison, not a race — CoW batches per
 *  block, so there is no runway to be first on. `t_actual_*` stays null and
 *  classify() therefore reports no lead time rather than inventing one.
 *  See SPEC-cowswap-resolver.md.
 */
import { config, pairForTokens } from '../../config.js';
import { Db, type TickInsert } from '../db/db.js';
import { GasPoller } from '../gas/poller.js';
import { RefPriceLoop, Sampler, rescaleBookDecimals } from '../kalqix/sampler.js';
import { chooseBookFetcher } from '../kalqix/client.js';
import { fetchKyberQuote } from '../kyber/client.js';
import { createBebopSource } from '../bebop/source.js';
import { walkBuyBaseFloat, walkSellBaseFloat } from '../bebop/depth.js';
import { walkBuyBase, walkSellBase } from '../kalqix/book.js';
import { SettlementFeed, type CowTrade } from './settlements.js';
import { CompetitionFeed, fetchCompetitionByTx, type CowCompetition } from './competition.js';
import { bpsOfCeil, ppmOfCeil, quoteForBaseCeil, rescale, toFloat } from '../pricing/units.js';
import { buildDecidedOutcome, OUTCOME_ORDER_SQL, OUTCOME_TICK_SQL } from '../report/outcome.js';
import { NATIVE_SENTINEL } from '../../config.js';
import { log, logError } from '../log.js';

const SDK_VERSION = 'cow-competition-1';

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
const bebop = createBebopSource((kind) => db.event(runId, kind, {}));
const { fetcher: bookFetcher } = config.hasKalqix
  ? await chooseBookFetcher(log)
  : { fetcher: undefined };
// Unlike the Fusion collector these run continuously rather than only while an
// order is live: a settlement arrives without warning and the book has to
// already be there to price it.
// One sampler per KalqiX *market*, not per pair. ETH/USDT and ETH/DAI are both
// priced off the ETH/USDC book, and a sampler each would fetch the same book
// three times a second and write three snapshot rows for it — snapshots were
// already the bulk of this schema's size on disk.
const kalqixPairs = config.pairs.filter((p) => p.kalqix);
const marketSamplers = new Map<string, { sampler: Sampler; baseDecimals: number; quoteDecimals: number }>();
for (const pair of kalqixPairs) {
  const k = pair.kalqix!;
  if (marketSamplers.has(k.ticker)) continue;
  // Sample in the market's own decimals so it can be restated for any pair that
  // uses it; rescaleBook is then a no-op for this one and explicit for the rest.
  const canonical = kalqixPairs.find(
    (p) => p.kalqix!.ticker === k.ticker &&
      p.base.decimals === p.kalqix!.baseDecimals &&
      p.quote.decimals === p.kalqix!.quoteDecimals
  ) ?? pair;
  marketSamplers.set(k.ticker, {
    sampler: new Sampler(canonical, db, () => runId, bookFetcher),
    baseDecimals: canonical.base.decimals,
    quoteDecimals: canonical.quote.decimals,
  });
}
const samplers = new Map([...marketSamplers].map(([market, m]) => [market, m.sampler]));
await gas.start();
await refPrices.start();
await bebop.start();
for (const s of samplers.values()) s.setActive(true);

const wethFor = (a: string) => (a.toLowerCase() === NATIVE_SENTINEL ? config.wethAddress : a.toLowerCase());

/** Quote assets worth a dollar. Widening beyond USDC means the USD notional
 *  can no longer key off the chain's single stableSymbol — a USDT or DAI leg is
 *  just as much a dollar, while a WBTC/ETH trade has no dollar leg at all. */
const STABLES = new Set(['USDC', 'USDT', 'DAI', 'BUSD']);

/** Value a wei amount in the token the user is paid in, so gas is subtracted in
 *  the same units as the proceeds. */
function weiToBuyToken(wei: bigint, buyDecimals: number, buySymbol: string): bigint | null {
  if (buySymbol === config.nativeSymbol) return wei;
  const mid = refPrices.latestMid.get(config.nativeTicker);
  if (mid === undefined) return null;
  // ETH_USDC is the reference, so this lands in 6dp dollars; a USDT or DAI leg
  // is treated as the same dollar and only rescaled.
  const inDollars = quoteForBaseCeil(wei, mid.mid, 18);
  if (STABLES.has(buySymbol)) return rescale(inDollars, 6, buyDecimals);
  return null; // non-stable, non-native leg: gas cannot be priced into it
}

let evaluated = 0;
let skipped = 0;
let fromAuction = 0;
let fromChain = 0;
/** Orders being priced right now. orderExists() is a database round trip, so
 *  two feeds can both pass it for the same order before either has written a
 *  row — the same duplicate-registration bug the Fusion collector already hit. */
const registering = new Set<string>();

async function evaluate(
  trade: CowTrade,
  comp: CowCompetition | null,
  source: 'auction' | 'chain'
): Promise<void> {
  if (registering.has(trade.orderUid)) return;
  registering.add(trade.orderUid);
  try {
    await evaluateInner(trade, comp, source);
  } finally {
    registering.delete(trade.orderUid);
  }
}

async function evaluateInner(
  trade: CowTrade,
  comp: CowCompetition | null,
  source: 'auction' | 'chain'
): Promise<void> {
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
  const market = pair.kalqix ? marketSamplers.get(pair.kalqix.ticker) ?? null : null;
  const snap = market?.sampler.latest ?? null;
  if (snap && pair.kalqix) {
    // The book is kept in its market's decimals; restate it into this pair's.
    // For ETH/DAI that moves every price 12 places, because DAI is 18dp and the
    // USDC book it is priced from is 6dp.
    const book = rescaleBookDecimals(
      snap.book,
      market!.baseDecimals,
      market!.quoteDecimals,
      pair.base.decimals,
      pair.quote.decimals
    );
    const walk =
      direction === 'SELL_BASE'
        ? walkSellBase(book.bids, trade.sellAmount, pair.base.decimals)
        : walkBuyBase(book.asks, trade.sellAmount, pair.base.decimals);
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
    // One chance per settled trade: unlike the Fusion loop there is no next
    // tick to recover on, so absorb a 429 rather than record 'no data'.
    const q = await fetchKyberQuote(sellToken, buyToken, trade.sellAmount, {
      retries: config.kyber.quoteRetries,
    });
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
  let bebopBookFound = false;
  let bebopOut: bigint | null = null;
  let bebopGasCost: bigint | null = null;
  let bebopFee: bigint | null = null;
  let edgeBebop: bigint | null = null;
  if (bebop.enabled) {
    const found = bebop.bookFor(sellToken, buyToken);
    if (found) {
      bebopBookFound = true;
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
    degraded: quoteLagMs > config.quoteLagToleranceMs,
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
    notionalUsdc: STABLES.has(buySymbol) ? rescale(cost, buyDecimals, 6) : null,
    edgeDefault,
    partialBestQty: null,
    partialBestEdge: null,
    kyberOut,
    kyberAmountIn: trade.sellAmount,
    // Null unless a quote actually came back: an age with no output is read
    // downstream as 'we had data and it was insufficient'.
    kyberQuoteAgeMs: kyberOut === null ? null : quoteLagMs,
    kyberDegraded: kyberOut === null ? null : quoteLagMs > config.quoteLagToleranceMs,
    kyberGasCost,
    kyberFee,
    edgeKyber,
    bebopOut,
    // Only when a book was found. Setting it unconditionally made every row
    // report 'book too thin' — including a 34 USD trade — when the truth was
    // that Bebop was disconnected and streaming no books at all.
    bebopAgeMs: bebopBookFound ? quoteLagMs : null,
    bebopDegraded: bebopBookFound ? quoteLagMs > config.quoteLagToleranceMs : null,
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
  // Written only now, after every venue has been asked. Inserting first and
  // settling afterwards left the row terminal_status NULL for the length of a
  // network call, so an already-settled trade surfaced under "being priced
  // right now" — and stayed there forever if a quote threw.
  await db.insertOrder({
    orderHash: trade.orderUid,
    runId,
    receivedAtMs: trade.blockTsMs,
    source,
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
    // Known by now: the tick was built above, so the funnel can show what
    // volume these percentages cover instead of '0 USD'.
    sizeUsd: tick.notionalUsdc === null ? null : toFloat(tick.notionalUsdc, 6),
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
    // The bar we would have had to clear. Only the competition feed knows it;
    // a trade recovered from a log carries nulls here.
    cowAuctionId: comp?.auctionId ?? null,
    cowSolverCount: comp?.solverCount ?? null,
    cowWinnerSolver: comp?.winnerSolver ?? null,
    cowWinnerScore: comp?.winnerScore ?? null,
    cowReferenceScore: comp?.referenceScore ?? null,
  });
  db.insertTick(tick);
  // Settled by definition. terminal_at_ms sits one ms after the tick so the tick
  // falls inside classify()'s decision horizon; t_actual stays null so no lead
  // time is reported.
  db.setTerminal(trade.orderUid, 'filled', null, trade.sellAmount, trade.buyAmount);
  // Keep the settlement tx. It was never stored, so `fills` sat empty and the
  // competition could not be looked up again for a row that missed it first time.
  if (trade.txHash) {
    db.upsertFill(trade.orderUid, trade.txHash, trade.sellAmount.toString(), trade.buyAmount.toString(), null);
    db.setFillBlock(trade.orderUid, trade.txHash, trade.blockNumber, trade.blockTsMs);
  }
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
  if (source === 'auction') fromAuction++;
  else fromChain++;
}

// Primary: the auction as it was decided.
const competition = new CompetitionFeed((t, c) => {
  void evaluate(t, c, 'auction').catch((err) =>
    logError(`evaluate ${t.orderUid.slice(0, 12)} failed`, err)
  );
});
// Backstop: anything the competition feed missed still shows up on chain.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const feed = new SettlementFeed((t) => {
  void (async () => {
    // Give the competition feed first refusal. It quotes ~3s after the block
    // and carries the solver scores; this path quotes ~15s after it and, until
    // the lookup below, carried none. Racing it was actively harmful.
    const wait = config.cow.backstopGraceMs - (Date.now() - t.blockTsMs);
    if (wait > 0) await sleep(wait);
    if (await db.orderExists(t.orderUid)) return; // the fast path got there
    // Recover the solver scores for auctions the live feed skipped. Without
    // this the backstop's rows carry no competition at all.
    const comp = t.txHash ? await fetchCompetitionByTx(t.txHash) : null;
    await evaluate(t, comp, 'chain');
  })().catch((err) => logError(`evaluate ${t.orderUid.slice(0, 12)} failed`, err));
});
await competition.start();
await feed.start();

const status = setInterval(() => {
  log(
    `status: auctions=${competition.auctionCount} trades=${competition.tradeCount}/${feed.tradeCount} ` +
      `evaluated=${evaluated} (auction=${fromAuction} chain=${fromChain}) unhedgeable=${skipped} ` +
      (competition.lastError ? `compErr=${competition.lastError} ` : '') +
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
  competition.stop();
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
