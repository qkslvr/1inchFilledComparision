/** cowswapSolver — would we have won the auction, and would the price have held?
 *
 *  The shadow dataset (cowswapResolver) asks a price question about trades that
 *  already happened. This one simulates actually competing, and the ordering is
 *  the whole point:
 *
 *    t0  the order is open and the winner is NOT known
 *        -> quote every venue. That is THE BID.
 *    t1  the auction resolves
 *        -> compare our score with the winner's.        WON / LOST
 *    t2  immediately after, and again after a delay
 *        -> quote every venue AGAIN.                    DID IT HOLD?
 *
 *  A quote taken at or after t1 must never become the bid: it has seen the same
 *  information the winner acted on. `recordBid` refuses to write once
 *  `resolved_at_ms` is set, which is what enforces that in the database rather
 *  than merely in the control flow.
 *
 *  The t2 check is the part no other tab measures. Winning an auction on a price
 *  that has evaporated by settlement is not a win, it is a loss you have to eat.
 *
 *  See SPEC-cowswap-solver.md. */
import { config, pairForTokens, NATIVE_SENTINEL } from '../../config.js';
import { Db, type TickInsert } from '../db/db.js';
import { GasPoller } from '../gas/poller.js';
import { RefPriceLoop, Sampler, rescaleBookDecimals } from '../kalqix/sampler.js';
import { chooseBookFetcher } from '../kalqix/client.js';
import { fetchKyberQuote } from '../kyber/client.js';
import { createBebopSource } from '../bebop/source.js';
import { walkBuyBaseFloat, walkSellBaseFloat } from '../bebop/depth.js';
import { walkBuyBase, walkSellBase } from '../kalqix/book.js';
import { parseAuctionSnapshot, type CowAuctionSnapshot } from './competition.js';
import { fetchSignedOrder, type CowSignedOrder } from './orders.js';
import { scoreOf, scoreMarginBps, wouldHaveWon } from './score.js';
import { bpsOfCeil, ppmOfCeil, quoteForBaseCeil, rescale, toFloat } from '../pricing/units.js';
import { buildDecidedOutcome, OUTCOME_ORDER_SQL, OUTCOME_TICK_SQL } from '../report/outcome.js';
import { log, logError } from '../log.js';

const SDK_VERSION = 'cow-solver-1';
const LATEST = 'https://api.cow.fi/mainnet/api/v2/solver_competition/latest';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const { fetcher: bookFetcher } = config.hasKalqix ? await chooseBookFetcher(log) : { fetcher: undefined };

// One sampler per KalqiX market, not per pair: several of our pairs price off
// the same book and a sampler each would fetch it repeatedly for nothing.
const kalqixPairs = config.pairs.filter((p) => p.kalqix);
const marketSamplers = new Map<string, { sampler: Sampler; baseDecimals: number; quoteDecimals: number }>();
for (const pair of kalqixPairs) {
  const k = pair.kalqix!;
  if (marketSamplers.has(k.ticker)) continue;
  const canonical =
    kalqixPairs.find(
      (p) =>
        p.kalqix!.ticker === k.ticker &&
        p.base.decimals === p.kalqix!.baseDecimals &&
        p.quote.decimals === p.kalqix!.quoteDecimals
    ) ?? pair;
  marketSamplers.set(k.ticker, {
    sampler: new Sampler(canonical, db, () => runId, bookFetcher),
    baseDecimals: canonical.base.decimals,
    quoteDecimals: canonical.quote.decimals,
  });
}

await gas.start();
await refPrices.start();
await bebop.start();
for (const m of marketSamplers.values()) m.sampler.setActive(true);

const wethFor = (a: string) => (a.toLowerCase() === NATIVE_SENTINEL ? config.wethAddress : a.toLowerCase());
const STABLES = new Set(['USDC', 'USDT', 'DAI', 'BUSD']);

/** Rough USD size of an order, from whichever leg is a dollar.
 *
 *  Reading only the buy side leaves every BUY_BASE order — where the user is
 *  paid in ETH or WBTC — with no size at all, which is what made the column
 *  empty. A stable on either side prices the trade just as well. */
function sizeUsdOf(
  order: CowSignedOrder,
  pair: (typeof config.pairs)[number],
  direction: 'SELL_BASE' | 'BUY_BASE'
): number | null {
  const buy = direction === 'SELL_BASE' ? pair.quote : pair.base;
  const sell = direction === 'SELL_BASE' ? pair.base : pair.quote;
  if (STABLES.has(buy.symbol)) return toFloat(rescale(order.buyAmount, buy.decimals, 6), 6);
  if (STABLES.has(sell.symbol)) return toFloat(rescale(order.sellAmount, sell.decimals, 6), 6);
  // Crypto-crypto, e.g. WBTC/ETH: no dollar leg, so no honest USD figure.
  return null;
}

function weiToBuyToken(wei: bigint, buyDecimals: number, buySymbol: string): bigint | null {
  if (buySymbol === config.nativeSymbol) return wei;
  const mid = refPrices.latestMid.get(config.nativeTicker);
  if (mid === undefined) return null;
  const inDollars = quoteForBaseCeil(wei, mid.mid, 18);
  if (STABLES.has(buySymbol)) return rescale(inDollars, 6, buyDecimals);
  return null;
}

export type Venue = 'kalqix' | 'kyber' | 'bebop';

interface VenueQuote {
  /** raw proceeds from the venue, in buyToken atoms */
  out: bigint;
  /** proceeds after every cost we would bear, i.e. what the user could receive */
  net: bigint;
  gasCost: bigint;
  fee: bigint;
}

/** Ask every venue what it would pay, and net off what filling would cost us.
 *
 *  Deliberately the same cost model as the other datasets — settlement gas, the
 *  venue's own swap leg, our markup and a safety margin — so a number here is
 *  comparable with a number there. */
async function quoteVenues(
  order: CowSignedOrder,
  pair: (typeof config.pairs)[number],
  direction: 'SELL_BASE' | 'BUY_BASE'
): Promise<Map<Venue, VenueQuote>> {
  const out = new Map<Venue, VenueQuote>();
  const buyDecimals = direction === 'SELL_BASE' ? pair.quote.decimals : pair.base.decimals;
  const buySymbol = direction === 'SELL_BASE' ? pair.quote.symbol : pair.base.symbol;
  const gasNow = gas.latest;
  const gasPriceWei = gasNow?.gasPriceWei ?? 0n;
  const fillGas = weiToBuyToken(config.gasUnits * gasPriceWei, buyDecimals, buySymbol) ?? 0n;
  const safety = bpsOfCeil(order.buyAmount, config.safetyMarginBps);

  // --- KalqiX ---
  const market = pair.kalqix ? marketSamplers.get(pair.kalqix.ticker) ?? null : null;
  const snap = market?.sampler.latest ?? null;
  if (snap && pair.kalqix) {
    const book = rescaleBookDecimals(
      snap.book,
      market!.baseDecimals,
      market!.quoteDecimals,
      pair.base.decimals,
      pair.quote.decimals
    );
    const walk =
      direction === 'SELL_BASE'
        ? walkSellBase(book.bids, order.sellAmount, pair.base.decimals)
        : walkBuyBase(book.asks, order.sellAmount, pair.base.decimals);
    if (walk.proceeds !== null) {
      const fee = ppmOfCeil(walk.proceeds, config.kalqixTakerFeeBps * 100n);
      out.set('kalqix', {
        out: walk.proceeds,
        net: walk.proceeds - fillGas - fee - safety,
        gasCost: fillGas,
        fee,
      });
    }
  }

  // --- Kyber ---
  try {
    const q = await fetchKyberQuote(order.sellToken, order.buyToken, order.sellAmount, {
      retries: config.kyber.quoteRetries,
    });
    const venueGas = weiToBuyToken(q.gasUnits * gasPriceWei, buyDecimals, buySymbol);
    if (venueGas !== null) {
      const fee = bpsOfCeil(q.amountOut, config.kyber.feeBps);
      out.set('kyber', {
        out: q.amountOut,
        net: q.amountOut - fillGas - venueGas - fee - safety,
        gasCost: fillGas + venueGas,
        fee,
      });
    }
  } catch (err) {
    logError(`kyber quote failed for ${order.uid.slice(0, 12)}`, err);
  }

  // --- Bebop ---
  if (bebop.enabled) {
    const found = bebop.bookFor(order.sellToken, order.buyToken);
    if (found) {
      const sellDecimals = direction === 'SELL_BASE' ? pair.base.decimals : pair.quote.decimals;
      const human = toFloat(order.sellAmount, sellDecimals);
      const raw = found.aIsBase
        ? walkSellBaseFloat(found.book.bids, human)
        : walkBuyBaseFloat(found.book.asks, human);
      if (raw !== null && raw > 0) {
        const amount =
          BigInt(Math.floor(raw * 10 ** Math.min(buyDecimals, 12))) *
          10n ** BigInt(Math.max(0, buyDecimals - 12));
        const venueGas = weiToBuyToken(config.bebop.gasUnits * gasPriceWei, buyDecimals, buySymbol);
        if (venueGas !== null) {
          const fee = bpsOfCeil(amount, config.bebop.feeBps);
          out.set('bebop', {
            out: amount,
            net: amount - fillGas - venueGas - fee - safety,
            gasCost: fillGas + venueGas,
            fee,
          });
        }
      }
    }
  }
  return out;
}

interface Tracked {
  order: CowSignedOrder;
  pair: (typeof config.pairs)[number];
  direction: 'SELL_BASE' | 'BUY_BASE';
  registered: boolean;
  quoteRounds: number;
  /** the last pre-resolution quote per venue — this is what we bid */
  lastQuotes: Map<Venue, VenueQuote>;
  lastQuoteAtMs: number;
  discoveredAtMs: number;
}

const tracked = new Map<string, Tracked>();
const seenUids = new Set<string>();
/** The solvable set already contains ~7,700 orders when we start, nearly all of
 *  them long-dated limit orders resting far from market. Bidding on those fills
 *  every slot with things that may never settle, so the first snapshot is used
 *  only to learn what already exists; we bid on what arrives after. */
let seeded = false;
let latestPrices = new Map<string, bigint>();
let discovered = 0;
let bidsPlaced = 0;
let resolvedCount = 0;
let wonCount = 0;
let holdChecks = 0;
let evicted = 0;
/** Why candidates were turned away. Without this the tracker reporting zero is
 *  indistinguishable from the feed being empty, which cost an afternoon. */
const rejected = { lookup: 0, notOpen: 0, expired: 0, noPair: 0, noQuote: 0, tooFar: 0, newUids: 0 };

/** Write one quote round as a tick, and update the standing bid.
 *
 *  Every round is stored, not just the last: the bid is only meaningful next to
 *  the quotes that preceded it, and the hold check compares against whichever
 *  round happened to be last before the auction closed. */
async function quoteRound(t: Tracked): Promise<void> {
  const quotes = await quoteVenues(t.order, t.pair, t.direction);
  const now = Date.now();
  t.lastQuotes = quotes;
  t.lastQuoteAtMs = now;
  t.quoteRounds++;

  const buyDecimals = t.direction === 'SELL_BASE' ? t.pair.quote.decimals : t.pair.base.decimals;
  const buySymbol = t.direction === 'SELL_BASE' ? t.pair.quote.symbol : t.pair.base.symbol;
  const gasNow = gas.latest;
  const k = quotes.get('kalqix');
  const ky = quotes.get('kyber');
  const bb = quotes.get('bebop');
  const marketSnap = t.pair.kalqix ? marketSamplers.get(t.pair.kalqix.ticker)?.sampler.latest ?? null : null;

  const tick: TickInsert = {
    orderHash: t.order.uid,
    tsMs: now,
    snapshotId: marketSnap?.id ?? null,
    snapshotAgeMs: marketSnap ? now - marketSnap.tsMs : null,
    degraded: marketSnap ? now - marketSnap.tsMs > config.quoteLagToleranceMs : false,
    exclusive: false,
    remainingMaker: t.order.sellAmount,
    rateBump: null,
    insufficientDepth: !!t.pair.kalqix && marketSnap !== null && k === undefined,
    hedgeProceeds: k?.out ?? null,
    // The limit is what a rival must beat, so it takes auctionCost's place.
    auctionCost: t.order.buyAmount,
    gasCostRaw: k?.gasCost ?? 0n,
    baseFeeWei: gasNow?.baseFeeWei ?? null,
    gasPriceWei: gasNow?.gasPriceWei ?? null,
    feeCost: k?.fee ?? null,
    notionalTaker: t.order.buyAmount,
    notionalUsdc: STABLES.has(buySymbol) ? rescale(t.order.buyAmount, buyDecimals, 6) : null,
    edgeDefault: k ? k.net - t.order.buyAmount : null,
    partialBestQty: null,
    partialBestEdge: null,
    kyberOut: ky?.out ?? null,
    kyberAmountIn: t.order.sellAmount,
    kyberQuoteAgeMs: ky ? 0 : null,
    kyberDegraded: ky ? false : null,
    kyberGasCost: ky?.gasCost ?? null,
    kyberFee: ky?.fee ?? null,
    edgeKyber: ky ? ky.net - t.order.buyAmount : null,
    bebopOut: bb?.out ?? null,
    bebopAgeMs: bb ? 0 : null,
    bebopDegraded: bb ? false : null,
    bebopGasCost: bb?.gasCost ?? null,
    bebopFee: bb?.fee ?? null,
    edgeBebop: bb ? bb.net - t.order.buyAmount : null,
    pancakeOut: null,
    pancakeAgeMs: null,
    pancakeDegraded: null,
    pancakeGasCost: null,
    pancakeFee: null,
    pancakeTier: null,
    edgePancake: null,
  };
  db.insertTick(tick);

  // The bid: the venue paying the user the most, after our costs.
  let best: { venue: Venue; q: VenueQuote } | null = null;
  for (const [venue, q] of quotes) if (!best || q.net > best.q.net) best = { venue, q };
  if (!best) return;
  const score = scoreOf({
    ourBuyAmount: best.q.net,
    limitBuyAmount: t.order.buyAmount,
    buyTokenPrice: latestPrices.get(t.order.buyToken),
  });
  if (score === null) return;
  // Ignored if the auction has already resolved — enforced in SQL, not here.
  db.recordBid(t.order.uid, score, best.venue, best.q.net, now);
  bidsPlaced++;
}

/** t2: does the price we bid on survive now that we know we won? */
async function checkHolds(t: Tracked, bidQuotes: Map<Venue, VenueQuote>, won: boolean): Promise<void> {
  for (const delay of config.cow.solverHoldDelaysMs) {
    if (delay > 0) await sleep(delay);
    const now = Date.now();
    const requotes = await quoteVenues(t.order, t.pair, t.direction);
    for (const [venue, bid] of bidQuotes) {
      const re = requotes.get(venue);
      // A venue that has gone away is not slippage; it is a fill we could not
      // have made at all, so it counts as not held with no slippage figure.
      const held = re ? re.net >= bid.net : false;
      const slippage =
        re && bid.net > 0n ? Number(((bid.net - re.net) * 10_000n) / bid.net) : re ? null : null;
      db.insertQuoteHold(t.order.uid, venue, delay, now, bid.net, re?.net ?? null, held, slippage, won);
      holdChecks++;
    }
  }
}

/** t1: the auction closed. Freeze the bid and grade it. */
async function resolve(t: Tracked, snap: CowAuctionSnapshot, settledBuyAmount: bigint): Promise<void> {
  const now = Date.now();
  const bidQuotes = t.lastQuotes;
  tracked.delete(t.order.uid);

  const price = snap.prices.get(t.order.buyToken) ?? latestPrices.get(t.order.buyToken);
  let ourScore: bigint | null = null;
  let best: { venue: Venue; q: VenueQuote } | null = null;
  for (const [venue, q] of bidQuotes) if (!best || q.net > best.q.net) best = { venue, q };
  if (best) {
    ourScore = scoreOf({ ourBuyAmount: best.q.net, limitBuyAmount: t.order.buyAmount, buyTokenPrice: price });
  }

  // The bar is what rivals offered on THIS order, not the winner's score for
  // their whole bundle. A solver bundling five orders out-scores us on volume
  // alone while possibly offering this user less, and comparing against that
  // reported us as crushed on orders we may have won outright. Each solution
  // states the buyAmount it would deliver per order, so every rival can be
  // scored on exactly our order, against the same limit and the same price.
  const proposals = snap.proposalsByOrder.get(t.order.uid) ?? [];
  let bestRivalScore: bigint | null = null;
  let bestRivalSolver: string | null = null;
  for (const p of proposals) {
    const rs = scoreOf({ ourBuyAmount: p.buyAmount, limitBuyAmount: t.order.buyAmount, buyTokenPrice: price });
    if (rs === null) continue;
    if (bestRivalScore === null || rs > bestRivalScore) {
      bestRivalScore = rs;
      bestRivalSolver = p.solver;
    }
  }

  const won = wouldHaveWon(ourScore, bestRivalScore);
  const margin =
    ourScore !== null && bestRivalScore !== null ? scoreMarginBps(ourScore, bestRivalScore) : null;
  db.recordResolution(t.order.uid, now, won, margin, bestRivalScore, bestRivalSolver, proposals.length);
  db.setTerminal(t.order.uid, 'filled', null, t.order.sellAmount, settledBuyAmount);
  await db.all(`UPDATE orders SET terminal_at_ms = ? WHERE order_hash = ?`, [now, t.order.uid]);
  await db.all(
    `UPDATE orders SET cow_auction_id = ?, cow_solver_count = ?, cow_winner_solver = ?,
       cow_winner_score = ?, cow_reference_score = ? WHERE order_hash = ?`,
    [
      snap.competition.auctionId,
      snap.competition.solverCount,
      snap.competition.winnerSolver,
      snap.competition.winnerScore?.toString() ?? null,
      snap.competition.referenceScore?.toString() ?? null,
      t.order.uid,
    ]
  );
  resolvedCount++;
  if (won) wonCount++;

  const row = await db.get(OUTCOME_ORDER_SQL, [t.order.uid]);
  if (row) {
    const raw = await db.all(OUTCOME_TICK_SQL, [t.order.uid]);
    db.upsertDecidedOutcome(buildDecidedOutcome(row, raw));
  }

  // Re-quote whether we won or lost. Losing bids are the control group: without
  // them a hold rate cannot be read, because there is no way to tell adverse
  // selection — our quote being stale is *why* we appeared to win — from the
  // market simply having moved for everyone in that window.
  if (bidQuotes.size > 0) {
    void checkHolds(t, bidQuotes, won).catch((err) => logError(`hold check ${t.order.uid.slice(0, 12)}`, err));
  }
}

/** Take on a newly seen open order, if it is one we could actually fill. */
async function consider(uid: string): Promise<void> {
  if (tracked.size >= config.cow.solverMaxTracked) return;
  const order = await fetchSignedOrder(uid);
  if (!order) {
    rejected.lookup++;
    return;
  }
  if (order.status !== 'open') {
    rejected.notOpen++;
    return;
  }
  if (order.validToMs && order.validToMs < Date.now()) {
    rejected.expired++;
    return;
  }
  const match = pairForTokens(wethFor(order.sellToken), wethFor(order.buyToken));
  if (!match) {
    rejected.noPair++;
    return;
  }
  // Most of the solvable set is long-dated limit orders resting far from market.
  // Quoting them all would flood the database for no signal, so an order has to
  // be within reach of a price we can actually source before we track it.
  const t: Tracked = {
    order,
    pair: match.pair,
    direction: match.direction,
    registered: false,
    quoteRounds: 0,
    lastQuotes: new Map(),
    lastQuoteAtMs: 0,
    discoveredAtMs: Date.now(),
  };
  const quotes = await quoteVenues(order, match.pair, match.direction);
  let best: VenueQuote | null = null;
  for (const q of quotes.values()) if (!best || q.net > best.net) best = q;
  if (!best) {
    rejected.noQuote++;
    return;
  }
  const distanceBps = Number(((order.buyAmount - best.net) * 10_000n) / order.buyAmount);
  if (distanceBps > Number(config.cow.solverMaxDistanceBps)) {
    rejected.tooFar++;
    log(`skip ${uid.slice(0, 12)} ${match.pair.ticker}: ${distanceBps} bps from our best price`);
    return;
  }

  await db.insertOrder({
    orderHash: order.uid,
    runId,
    receivedAtMs: Date.now(),
    source: 'auction',
    lateSeen: false,
    makerAsset: order.sellToken,
    takerAsset: order.buyToken,
    makingAmount: order.sellAmount,
    takingAmount: order.buyAmount,
    remainingMaker: order.sellAmount,
    makerAddress: order.owner,
    pair: match.pair.ticker,
    direction: match.direction,
    hedgeAssetKind: null,
    eligible: true,
    kyberOnly: false,
    skipReason: null,
    sizeUsd: sizeUsdOf(order, match.pair, match.direction),
    auctionStartMs: null,
    auctionDurationS: null,
    initialRateBump: null,
    auctionPointsJson: null,
    gasBumpEstimate: null,
    gasPriceEstimate: null,
    allowPartialFills: order.partiallyFillable,
    allowMultipleFills: null,
    deadlineMs: order.validToMs || null,
    extensionRaw: null,
    orderStructJson: null,
    limitSellAmount: order.sellAmount,
    limitBuyAmount: order.buyAmount,
    validToMs: order.validToMs || null,
    partiallyFillable: order.partiallyFillable,
  });
  t.registered = true;
  tracked.set(uid, t);
  discovered++;
  await quoteRound(t);
}

async function pollAuction(): Promise<void> {
  const res = await fetch(LATEST, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const snap = parseAuctionSnapshot(await res.json());
  if (!snap) return;
  if (snap.prices.size > 0) latestPrices = snap.prices;

  // t1 first: anything of ours that settled in this auction is now decided, and
  // must stop accruing bids before we look at what else is open.
  for (const s of snap.settled) {
    const t = tracked.get(s.uid);
    if (t) await resolve(t, snap, s.buyAmount);
  }

  // Free slots held by orders that are not going to resolve. Without this the
  // tracker fills once and never turns over, and nothing ever gets graded.
  const now = Date.now();
  for (const [uid, t] of [...tracked]) {
    const tooOld = now - t.discoveredAtMs > config.cow.solverMaxTrackAgeMs;
    // Past validTo is not the end of the story: the settlement that decides
    // the auction usually lands at or just after it, and that is the moment
    // we are waiting for.
    const expired = t.order.validToMs > 0 && now - t.order.validToMs > config.cow.solverExpiryGraceMs;
    if (!tooOld && !expired) continue;
    tracked.delete(uid);
    evicted++;
    db.setTerminal(uid, expired ? 'expired' : 'unresolved', null, 0n, 0n);
  }

  // Then discovery. The solvable set turns over by only a handful of uids per
  // auction, so this is a few lookups rather than thousands.
  for (const uid of snap.orderUids) {
    if (seenUids.has(uid)) continue;
    seenUids.add(uid);
    if (!seeded) continue; // startup backlog: noted, not bid on
    rejected.newUids++;
    if (tracked.size >= config.cow.solverMaxTracked) continue;
    await consider(uid).catch((err) => logError(`consider ${uid.slice(0, 12)}`, err));
  }
  if (!seeded) {
    seeded = true;
    log(`seeded from ${seenUids.size} standing orders; bidding on new arrivals only`);
  }
  if (seenUids.size > 50_000) seenUids.clear();
}

let auctionInFlight = false;
const auctionTimer = setInterval(() => {
  if (auctionInFlight) return;
  auctionInFlight = true;
  void pollAuction()
    .catch((err) => logError('cow solver auction poll failed', err))
    .finally(() => {
      auctionInFlight = false;
    });
}, config.cow.competitionPollMs);

// Phase B: keep quoting everything open. This is what makes the bid a live
// price rather than a stale one, and it is the behaviour being evaluated —
// whether continuously polling is worth it is one of the questions.
const quoteTimer = setInterval(() => {
  for (const t of [...tracked.values()]) {
    void quoteRound(t).catch((err) => logError(`quote round ${t.order.uid.slice(0, 12)}`, err));
  }
}, config.cow.solverQuoteIntervalMs);

const status = setInterval(() => {
  log(
    `status: tracked=${tracked.size} discovered=${discovered} bids=${bidsPlaced} ` +
      `resolved=${resolvedCount} won=${wonCount} holdChecks=${holdChecks} evicted=${evicted} ` +
      `new=${rejected.newUids} rejected(lookup=${rejected.lookup} notOpen=${rejected.notOpen} ` +
      `expired=${rejected.expired} noPair=${rejected.noPair} noQuote=${rejected.noQuote} tooFar=${rejected.tooFar}) ` +
      `bebop=${bebop.enabled ? `${bebop.state}/${bebop.books.size}pairs` : 'off'} ` +
      (db.storagePressure ? ` STORAGE-PRESSURE(${db.droppedTicks} dropped)` : '')
  );
}, 60_000);

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log('SIGINT: shutting down...');
  clearInterval(auctionTimer);
  clearInterval(quoteTimer);
  clearInterval(status);
  bebop.stop();
  for (const m of marketSamplers.values()) m.sampler.stop();
  refPrices.stop();
  gas.stop();
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

log('cowswapSolver running (Ctrl+C to stop)');
