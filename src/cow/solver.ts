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
import { kyberBudget, KyberBudgetExhausted } from '../kyber/client.js';
import { createBebopSource } from '../bebop/source.js';
import { walkBuyBaseFloat, walkSellBaseFloat } from '../bebop/depth.js';
import { walkBuyBase, walkSellBase } from '../kalqix/book.js';
import { parseAuctionSnapshot, type CowAuctionSnapshot } from './competition.js';
import { fetchSignedOrder, type CowSignedOrder } from './orders.js';
import { scoreOf, scoreOfBuy, scoreMarginBps, notionalNative, wouldHaveWon } from './score.js';
import { tokenDecimals, tokenSymbol, weiToTokenViaUsd } from './tokens.js';
import { takePollSlot } from './pollgate.js';
import { getJson, HttpStatusError } from '../http/json.js';
import { bpsOfCeil, ppmOfCeil, quoteForBaseCeil, rescale, toFloat } from '../pricing/units.js';
import { buildDecidedOutcome, OUTCOME_ORDER_SQL, OUTCOME_TICK_SQL } from '../report/outcome.js';
import { log, logError } from '../log.js';

const SDK_VERSION = 'cow-solver-1';
const LATEST = `${config.cow.apiBase}/${config.cow.chainSlug}/api/v2/solver_competition/latest`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// KalqiX and Bebop are in-memory and free; only Kyber costs a request, so it is
// the only thing that has to be rationed as the tracked count grows. The bucket
// lives in the client so retries are charged to it too.
/** Last Kyber answer per order, so a round that loses the draw ages its quote
 *  instead of losing the venue entirely. */
const lastKyber = new Map<string, { q: Awaited<ReturnType<typeof fetchKyberQuote>>; atMs: number }>();

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

/** Short label for a token we have no pair config for. */
function tokenLabel(address: string): string {
  const a = address.toLowerCase();
  for (const pair of config.pairs) {
    for (const side of [pair.base, pair.quote]) {
      if (side.addresses.some((x) => x.toLowerCase() === a)) return side.symbol;
    }
  }
  return a.slice(0, 6) + '\u2026';
}

/** Rough USD size of an order, from whichever leg is a dollar.
 *
 *  Only works for a configured pair, which since the pair filter was dropped is
 *  a small minority — 10 of 171 orders had a size. `sizeUsdFromQuote` covers
 *  the rest.
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

/** USD size for a token we have no pair config for.
 *
 *  Kyber already values its own output in dollars, so the trade's size comes
 *  free with a quote we were making anyway — no extra request, no price feed. */
function sizeUsdFromQuote(quotes: Map<Venue, VenueQuote>): number | null {
  const usd6 = quotes.get('kyber')?.outUsd6;
  if (usd6 === null || usd6 === undefined || usd6 <= 0n) return null;
  const usd = toFloat(usd6, 6);
  // An illiquid pair can produce a nonsense valuation, and one such row was the
  // whole volume headline. No size is more honest than a false one.
  return usd > config.cow.maxBelievableSizeUsd ? null : usd;
}

/** Native token price in 6dp dollars.
 *
 *  RefPriceLoop gets this from a KalqiX book, which only exists on the chains
 *  KalqiX lists. On Arbitrum there is none, so every gas conversion returned
 *  null, so every venue quote was discarded and the dataset recorded nothing at
 *  all while reporting noQuote. Kyber already prices any chain it supports, so
 *  ask it — one quote every few minutes, cached. */
let nativeUsdCache: { usd6: bigint; atMs: number } | null = null;
async function refreshNativeUsd(): Promise<void> {
  const weth = config.wethAddress;
  const stable = config.pairs.find((p) => STABLES.has(p.quote.symbol))?.quote;
  if (!stable) return;
  try {
    const q = await fetchKyberQuote(weth, stable.addresses[0]!, 10n ** 18n, { retries: 0 });
    if (q.amountOut > 0n) {
      nativeUsdCache = { usd6: rescale(q.amountOut, stable.decimals, 6), atMs: Date.now() };
    }
  } catch {
    // Leave the previous value in place; a stale native price is far better
    // than no venue quotes at all.
  }
}

function nativeUsd6(): bigint | undefined {
  const mid = refPrices.latestMid.get(config.nativeTicker);
  if (mid !== undefined) return mid.mid;
  return nativeUsdCache?.usd6;
}

function weiToToken(wei: bigint, decimals: number, symbol: string): bigint | null {
  if (symbol === config.nativeSymbol) return wei;
  const usd6 = nativeUsd6();
  if (usd6 === undefined) return null;
  const mid = { mid: usd6 };
  const inDollars = quoteForBaseCeil(wei, mid.mid, 18);
  if (STABLES.has(symbol)) return rescale(inDollars, 6, decimals);
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
  /** Gas in native wei, kept unconverted. A buy order needs it in sellToken,
   *  a sell order in buyToken, and converting early loses that choice. */
  gasWei: bigint;
  feeBps: bigint;
  /** the venue's own USD valuation of `out`, 6dp, where it offers one. It is
   *  the only price available for a token outside our pair config. */
  outUsd6: bigint | null;
}

/** Ask every venue what it would pay, and net off what filling would cost us.
 *
 *  Deliberately the same cost model as the other datasets — settlement gas, the
 *  venue's own swap leg, our markup and a safety margin — so a number here is
 *  comparable with a number there. */
async function quoteVenues(t: {
  order: CowSignedOrder;
  pair: (typeof config.pairs)[number] | null;
  direction: 'SELL_BASE' | 'BUY_BASE' | null;
  buyDecimals: number;
  sellDecimals: number;
}): Promise<Map<Venue, VenueQuote>> {
  const { order, pair, direction, buyDecimals } = t;
  const out = new Map<Venue, VenueQuote>();
  const buySymbol =
    pair && direction ? (direction === 'SELL_BASE' ? pair.quote.symbol : pair.base.symbol) : '';
  const gasNow = gas.latest;
  const gasPriceWei = gasNow?.gasPriceWei ?? 0n;
  const fillGas = weiToToken(config.gasUnits * gasPriceWei, buyDecimals, buySymbol) ?? 0n;
  const safety = bpsOfCeil(order.buyAmount, config.safetyMarginBps);

  // --- KalqiX --- only where we have a book for the pair
  const market = pair?.kalqix ? marketSamplers.get(pair.kalqix.ticker) ?? null : null;
  const snap = market?.sampler.latest ?? null;
  if (snap && pair?.kalqix && direction) {
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
        gasWei: config.gasUnits * gasPriceWei,
        feeBps: config.kalqixTakerFeeBps,
        outUsd6: null,
      });
    }
  }

  // --- Kyber ---
  try {
    let q: Awaited<ReturnType<typeof fetchKyberQuote>> | null = null;
    try {
      // No retries here: with 60 orders competing for the budget, breadth is
      // worth more than a second attempt at one of them.
      q = await fetchKyberQuote(order.sellToken, order.buyToken, order.sellAmount, { retries: 0 });
      lastKyber.set(order.uid, { q, atMs: Date.now() });
    } catch (err) {
      if (!(err instanceof KyberBudgetExhausted)) throw err;
      const prev = lastKyber.get(order.uid);
      // Reuse only while it is plausibly still the price. Past that, no Kyber
      // column is honest; a stale one is not.
      if (prev && Date.now() - prev.atMs < config.cow.kyberQuoteMaxAgeMs) q = prev.q;
    }
    if (q === null) throw new Error('no kyber budget and no fresh quote');
    // For a configured pair we can price gas through the reference book; for an
    // arbitrary token the quote's own USD figure is the only rate to hand, and
    // it is right there in the response.
    const venueGas =
      weiToToken(q.gasUnits * gasPriceWei, buyDecimals, buySymbol) ??
      weiToTokenViaUsd(q.gasUnits * gasPriceWei, nativeUsd6(), q.amountOut, q.amountOutUsd6);
    const fillGasHere =
      fillGas ||
      weiToTokenViaUsd(config.gasUnits * gasPriceWei, nativeUsd6(), q.amountOut, q.amountOutUsd6) ||
      0n;
    if (venueGas !== null) {
      const fee = bpsOfCeil(q.amountOut, config.kyber.feeBps);
      out.set('kyber', {
        out: q.amountOut,
        net: q.amountOut - fillGasHere - venueGas - fee - safety,
        gasCost: fillGasHere + venueGas,
        fee,
        gasWei: (config.gasUnits + q.gasUnits) * gasPriceWei,
        feeBps: config.kyber.feeBps,
        outUsd6: q.amountOutUsd6,
      });
    }
  } catch (err) {
    if (!String(err).includes('no kyber budget')) {
      logError(`kyber quote failed for ${order.uid.slice(0, 12)}`, err);
    }
  }

  // --- Bebop ---
  if (bebop.enabled) {
    const found = bebop.bookFor(order.sellToken, order.buyToken);
    if (found) {
      const human = toFloat(order.sellAmount, t.sellDecimals);
      const raw = found.aIsBase
        ? walkSellBaseFloat(found.book.bids, human)
        : walkBuyBaseFloat(found.book.asks, human);
      if (raw !== null && raw > 0) {
        const amount =
          BigInt(Math.floor(raw * 10 ** Math.min(buyDecimals, 12))) *
          10n ** BigInt(Math.max(0, buyDecimals - 12));
        const venueGas = weiToToken(config.bebop.gasUnits * gasPriceWei, buyDecimals, buySymbol);
        if (venueGas !== null) {
          const fee = bpsOfCeil(amount, config.bebop.feeBps);
          out.set('bebop', {
            out: amount,
            net: amount - fillGas - venueGas - fee - safety,
            gasCost: fillGas + venueGas,
            fee,
            gasWei: (config.gasUnits + config.bebop.gasUnits) * gasPriceWei,
            feeBps: config.bebop.feeBps,
            outUsd6: null,
          });
        }
      }
    }
  }
  return out;
}

interface Tracked {
  order: CowSignedOrder;
  /** Present only when the pair is one we have a KalqiX book for. Everything
   *  else is priced from Kyber and Bebop, which quote by address. */
  pair: (typeof config.pairs)[number] | null;
  direction: 'SELL_BASE' | 'BUY_BASE' | null;
  sellDecimals: number;
  buyDecimals: number;
  sellSymbol: string | null;
  buySymbol: string | null;
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
const rejected = { lookup: 0, notOpen: 0, expired: 0, noDecimals: 0, noQuote: 0, tooFar: 0, newUids: 0, giveUp: 0 };
/** Lookup attempts per uid, so a retry cannot become an infinite one. */
const attempts = new Map<string, number>();

/** What our bid is worth, in native wei, for either kind of order.
 *
 *  SELL: we receive `out` for the user's sellAmount, pay our costs out of it,
 *        and anything above their floor is surplus.
 *  BUY:  the user must receive exactly limitBuyAmount, so the question inverts
 *        — how little of their sellToken do we need? The venue quote is for
 *        spending the whole cap, so scale it down to the amount actually
 *        needed. Price impact is convex, so spending less gets a rate at least
 *        as good: the linear estimate over-states our input and therefore
 *        under-states our surplus, which is the safe direction to be wrong in.
 */
function bidScore(t: Tracked, q: VenueQuote, prices: Map<string, bigint>): bigint | null {
  if (t.order.kind === 'sell') {
    return scoreOf({
      ourBuyAmount: q.net,
      limitBuyAmount: t.order.buyAmount,
      buyTokenPrice: prices.get(t.order.buyToken),
    });
  }

  if (q.out <= 0n) return null;
  const requiredIn = (t.order.sellAmount * t.order.buyAmount + q.out - 1n) / q.out;
  // Gas in the token being spent. Without a configured pair we have no symbol to
  // recognise, so fall back to the quote's own dollar rate on the output and
  // convert across at the order's own implied price.
  const gasInSell =
    weiToTokenViaUsd(q.gasWei, nativeUsd6(), q.out, q.outUsd6) === null
      ? null
      : ((weiToTokenViaUsd(q.gasWei, nativeUsd6(), q.out, q.outUsd6) as bigint) *
          t.order.sellAmount) /
        (q.out === 0n ? 1n : q.out);
  if (gasInSell === null) return null;
  const fee = bpsOfCeil(requiredIn, q.feeBps);
  const safety = bpsOfCeil(t.order.sellAmount, config.safetyMarginBps);
  return scoreOfBuy({
    spentSellAmount: requiredIn + gasInSell + fee + safety,
    limitSellAmount: t.order.sellAmount,
    sellTokenPrice: prices.get(t.order.sellToken),
  });
}

/** How far below the user's limit our best price sits, in bps, for either kind.
 *
 *  Positive means short. On a SELL order that is the buyToken we fail to
 *  deliver; on a BUY order it is the extra sellToken we would need to spend.
 *  Used only to decide whether an order is close enough to be worth tracking —
 *  most of the solvable set is resting far from market. */
function shortfallBps(t: Tracked, q: VenueQuote): number | null {
  if (t.order.kind === 'sell') {
    if (t.order.buyAmount <= 0n) return null;
    return Number(((t.order.buyAmount - q.net) * 10_000n) / t.order.buyAmount);
  }
  if (q.out <= 0n || t.order.sellAmount <= 0n) return null;
  const requiredIn = (t.order.sellAmount * t.order.buyAmount + q.out - 1n) / q.out;
  const spend = requiredIn + bpsOfCeil(requiredIn, q.feeBps) + bpsOfCeil(t.order.sellAmount, config.safetyMarginBps);
  return Number(((spend - t.order.sellAmount) * 10_000n) / t.order.sellAmount);
}

/** What a rival's proposal is worth on this order, same units, same rules. */
function rivalScore(
  t: Tracked,
  p: { buyAmount: bigint; sellAmount: bigint },
  prices: Map<string, bigint>
): bigint | null {
  return t.order.kind === 'sell'
    ? scoreOf({
        ourBuyAmount: p.buyAmount,
        limitBuyAmount: t.order.buyAmount,
        buyTokenPrice: prices.get(t.order.buyToken),
      })
    : scoreOfBuy({
        spentSellAmount: p.sellAmount,
        limitSellAmount: t.order.sellAmount,
        sellTokenPrice: prices.get(t.order.sellToken),
      });
}

/** Write one quote round as a tick, and update the standing bid.
 *
 *  Every round is stored, not just the last: the bid is only meaningful next to
 *  the quotes that preceded it, and the hold check compares against whichever
 *  round happened to be last before the auction closed. */
async function quoteRound(t: Tracked): Promise<void> {
  const quotes = await quoteVenues(t);
  const now = Date.now();
  t.lastQuotes = quotes;
  t.lastQuoteAtMs = now;
  t.quoteRounds++;

  const buyDecimals = t.buyDecimals;
  const buySymbol =
    t.pair && t.direction ? (t.direction === 'SELL_BASE' ? t.pair.quote.symbol : t.pair.base.symbol) : '';
  const gasNow = gas.latest;
  const k = quotes.get('kalqix');
  const ky = quotes.get('kyber');
  const bb = quotes.get('bebop');
  const marketSnap = t.pair?.kalqix ? marketSamplers.get(t.pair.kalqix.ticker)?.sampler.latest ?? null : null;

  const tick: TickInsert = {
    orderHash: t.order.uid,
    tsMs: now,
    snapshotId: marketSnap?.id ?? null,
    snapshotAgeMs: marketSnap ? now - marketSnap.tsMs : null,
    degraded: marketSnap ? now - marketSnap.tsMs > config.quoteLagToleranceMs : false,
    exclusive: false,
    remainingMaker: t.order.sellAmount,
    rateBump: null,
    insufficientDepth: !!t.pair?.kalqix && marketSnap !== null && k === undefined,
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

  // The bid: whichever venue produces the best SCORE. Ranking on buy-side net
  // instead would be meaningless on a buy order, where the user's proceeds are
  // fixed and the whole contest is about spending less.
  let best: { venue: Venue; score: bigint } | null = null;
  for (const [venue, q] of quotes) {
    const sc = bidScore(t, q, latestPrices);
    if (sc === null) continue;
    if (!best || sc > best.score) best = { venue, score: sc };
  }
  if (!best) return;
  const score = best.score;
  // Ignored if the auction has already resolved — enforced in SQL, not here.
  db.recordBid(t.order.uid, score, best.venue, quotes.get(best.venue)!.net, now);
  bidsPlaced++;
}

/** t2: does the price we bid on survive now that we know we won? */
async function checkHolds(t: Tracked, bidQuotes: Map<Venue, VenueQuote>, won: boolean): Promise<void> {
  for (const delay of config.cow.solverHoldDelaysMs) {
    if (delay > 0) await sleep(delay);
    const now = Date.now();
    const requotes = await quoteVenues(t);
    for (const [venue, bid] of bidQuotes) {
      const re = requotes.get(venue);
      // A venue that has gone away is not slippage; it is a fill we could not
      // have made at all, so it counts as not held with no slippage figure.
      const slippage =
        re && bid.net > 0n ? Number(((bid.net - re.net) * 10_000n) / bid.net) : null;
      // "Held" means the price was still there, not that it matched to the wei.
      // The tolerance is measurement noise, deliberately not the safety margin —
      // that is now zero, and a strict test reported 37 re-quotes as slipped
      // beside 0.0 bps of slippage.
      const held =
        re !== undefined && slippage !== null && slippage <= Number(config.cow.solverHoldToleranceBps);
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
  lastKyber.delete(t.order.uid);

  // Prefer the auction's own price vector; fall back to the last one we saw.
  const prices = snap.prices.size > 0 ? snap.prices : latestPrices;
  let ourScore: bigint | null = null;
  let best: { venue: Venue; q: VenueQuote } | null = null;
  for (const [venue, q] of bidQuotes) {
    const sc = bidScore(t, q, prices);
    if (sc === null) continue;
    if (ourScore === null || sc > ourScore) {
      ourScore = sc;
      best = { venue, q };
    }
  }

  // The venue's own dollar valuation of its output, where it gives one — used to
  // express our markup in money rather than as a fraction of an opaque amount.
  const quotes0Usd = best?.q.outUsd6 ? toFloat(best.q.outUsd6, 6) : null;

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
    const rs = rivalScore(t, p, prices);
    if (rs === null) continue;
    if (bestRivalScore === null || rs > bestRivalScore) {
      bestRivalScore = rs;
      bestRivalSolver = p.solver;
    }
  }

  const won = wouldHaveWon(ourScore, bestRivalScore);
  // A zero score means our best venue could not clear the user's limit at all.
  // That is not a bid, so it has no margin — feeding it in as a floor value
  // dragged the median onto it.
  const hadBid = ourScore !== null && ourScore > 0n;
  const notional =
    t.order.kind === 'sell'
      ? notionalNative(t.order.buyAmount, prices.get(t.order.buyToken))
      : notionalNative(t.order.sellAmount, prices.get(t.order.sellToken));
  const margin =
    hadBid && bestRivalScore !== null && notional !== null
      ? scoreMarginBps(ourScore!, bestRivalScore, notional)
      : null;

  // --- the named solver we are pitching, where one is configured -------------
  //
  // Their own proposal is the bar, not the auction winner's. "We would have won
  // this auction" is a claim about the whole field and depends on how everyone
  // else would have reacted; "our price beat the one you actually submitted, on
  // this order" is a claim about them alone, and it is the one that can be
  // checked from the record.
  const targetAddr = config.cow.targetSolver;
  let target:
    | { bid: boolean; won: boolean; score: bigint | null; rank: number | null; beat: boolean | null; vsBps: number | null }
    | undefined;
  if (targetAddr) {
    const theirs = proposals.find((p) => p.solver === targetAddr);
    if (!theirs) {
      target = { bid: false, won: false, score: null, rank: null, beat: null, vsBps: null };
    } else {
      const theirScore = rivalScore(t, theirs, prices);
      target = {
        bid: true,
        won: theirs.isWinner,
        score: theirScore,
        rank: theirs.ranking,
        beat: ourScore !== null && theirScore !== null ? ourScore > theirScore : null,
        vsBps:
          ourScore !== null && theirScore !== null && notional !== null
            ? scoreMarginBps(ourScore, theirScore, notional)
            : null,
      };
    }
  }

  // Scores are native wei, so the reference ETH price turns them into money.
  // This is what the trade is actually worth, rather than bps of something.
  const ethUsd6 = nativeUsd6();
  const toUsd = (wei: bigint | null): number | null =>
    wei === null || ethUsd6 === undefined ? null : toFloat(wei, 18) * toFloat(ethUsd6, 6);
  const feeUsd =
    best && quotes0Usd !== null && best.q.out > 0n
      ? (toFloat(best.q.fee, t.buyDecimals) / toFloat(best.q.out, t.buyDecimals)) * quotes0Usd
      : null;
  db.recordResolution(
    t.order.uid, now, won, margin, bestRivalScore, bestRivalSolver, proposals.length,
    {
      surplus: toUsd(ourScore),
      edge: ourScore !== null && bestRivalScore !== null ? toUsd(ourScore - bestRivalScore) : null,
      fee: feeUsd,
    },
    target
  );
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
type Verdict = 'done' | 'retry';

async function consider(uid: string): Promise<Verdict> {
  if (tracked.size >= config.cow.solverMaxTracked) return 'retry';
  const order = await fetchSignedOrder(uid);
  if (!order) {
    // Could be a rate-limit slot we never got, or a network blip. Either way we
    // learned nothing, so this is not a decision about the order.
    rejected.lookup++;
    return 'retry';
  }
  if (order.status !== 'open') {
    rejected.notOpen++;
    return 'done';
  }
  if (order.validToMs && order.validToMs < Date.now()) {
    rejected.expired++;
    return 'done';
  }
  // A configured pair is a bonus, not a requirement: it unlocks the KalqiX book.
  // Kyber and Bebop quote by address, so everything else is still priceable, and
  // insisting on a pair was rejecting the large majority of CoW's flow.
  const match = pairForTokens(wethFor(order.sellToken), wethFor(order.buyToken));
  const sellDecimals = await tokenDecimals(order.sellToken, (a) => bebop.decimalsFor(a));
  const buyDecimals = await tokenDecimals(order.buyToken, (a) => bebop.decimalsFor(a));
  if (sellDecimals === null || buyDecimals === null) {
    // Without decimals every amount is meaningless, so this is the one case we
    // genuinely cannot price.
    rejected.noDecimals++;
    return 'retry';
  }
  // Most of the solvable set is long-dated limit orders resting far from market.
  // Quoting them all would flood the database for no signal, so an order has to
  // be within reach of a price we can actually source before we track it.
  const [sellSymbol, buySymbol] = await Promise.all([
    tokenSymbol(order.sellToken),
    tokenSymbol(order.buyToken),
  ]);
  const t: Tracked = {
    order,
    sellSymbol,
    buySymbol,
    pair: match ? match.pair : null,
    direction: match ? match.direction : null,
    sellDecimals,
    buyDecimals,
    registered: false,
    quoteRounds: 0,
    lastQuotes: new Map(),
    lastQuoteAtMs: 0,
    discoveredAtMs: Date.now(),
  };
  const quotes = await quoteVenues(t);
  if (quotes.size === 0) {
    rejected.noQuote++;
    return 'retry';
  }
  let distanceBps: number | null = null;
  for (const q of quotes.values()) {
    const d = shortfallBps(t, q);
    if (d !== null && (distanceBps === null || d < distanceBps)) distanceBps = d;
  }
  if (distanceBps === null || distanceBps > Number(config.cow.solverMaxDistanceBps)) {
    rejected.tooFar++;
    return 'done';
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
    pair: match ? match.pair.ticker : `${sellSymbol ?? tokenLabel(order.sellToken)}/${buySymbol ?? tokenLabel(order.buyToken)}`,
    direction: match ? match.direction : null,
    hedgeAssetKind: null,
    eligible: true,
    kyberOnly: false,
    skipReason: null,
    sizeUsd: (match ? sizeUsdOf(order, match.pair, match.direction) : null) ?? sizeUsdFromQuote(quotes),
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
    orderKind: order.kind,
    sellSymbol,
    buySymbol,
  });
  t.registered = true;
  tracked.set(uid, t);
  discovered++;
  await quoteRound(t);
  return 'done';
}

let slotDenied = 0;

async function pollAuction(): Promise<void> {
  // Every process on this host shares one CoW rate limit, so they take turns
  // rather than compete. Skipping a tick costs nothing — auctions advance far
  // slower than we poll — whereas colliding costs a 429 and a 30s penalty.
  if (!takePollSlot()) {
    slotDenied++;
    return;
  }
  let raw: Parameters<typeof parseAuctionSnapshot>[0];
  try {
    raw = await getJson<Parameters<typeof parseAuctionSnapshot>[0]>(LATEST);
  } catch (err) {
    if (err instanceof HttpStatusError && err.status === 429) {
      auctionBackoffUntil = Date.now() + config.cow.rateLimitBackoffMs;
    }
    throw err;
  }
  const snap = parseAuctionSnapshot(raw);
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
    lastKyber.delete(uid);
    evicted++;
    db.setTerminal(uid, expired ? 'expired' : 'unresolved', null, 0n, 0n);
    // Without this the row has a terminal_status but no terminal_at_ms, and
    // every prune rule keys off the timestamp — so 4,726 evicted orders held
    // their ticks forever and the storage valve started shedding live writes.
    void db.all(`UPDATE orders SET terminal_at_ms = ? WHERE order_hash = ?`, [now, uid]);
  }

  // Then discovery.
  //
  // A uid is only written off once we have actually decided something about it.
  // Marking it seen before the attempt meant a transient failure burned it
  // permanently: 417 orders were skipped in one run because their lookups timed
  // out waiting for the rate-limit slot, and every one was then ignored forever
  // even though nothing had been learned about it. Same for orders arriving
  // while the tracker was full.
  for (const uid of snap.orderUids) {
    if (seenUids.has(uid)) continue;
    // Where the chain's solvable list lags, the backlog is the live flow: the
    // uids arriving at the head are already closed, and the open orders are the
    // ones sitting in the set we would otherwise skip.
    if (!seeded && !config.cow.bidOnBacklog) {
      seenUids.add(uid); // startup backlog: noted, never bid on
      continue;
    }
    // No room right now is not a verdict on the order. Leave it unseen so it is
    // reconsidered when a slot frees up.
    if (tracked.size >= config.cow.solverMaxTracked) continue;

    const verdict = await consider(uid).catch((err) => {
      logError(`consider ${uid.slice(0, 12)}`, err);
      return 'retry' as const;
    });
    if (verdict === 'done') {
      seenUids.add(uid);
      attempts.delete(uid);
      rejected.newUids++;
      continue;
    }
    // Retry, but not forever: an order we can never resolve would otherwise be
    // reconsidered on every single poll for as long as it stays solvable.
    const n = (attempts.get(uid) ?? 0) + 1;
    attempts.set(uid, n);
    if (n >= config.cow.maxLookupAttempts) {
      seenUids.add(uid);
      attempts.delete(uid);
      rejected.giveUp++;
    }
  }
  if (!seeded) {
    seeded = true;
    log(`seeded from ${seenUids.size} standing orders; bidding on new arrivals only`);
  }
  if (seenUids.size > 50_000) seenUids.clear();
}

let auctionInFlight = false;
// Stagger the first poll. Both datasets are started by the same supervisor pass,
// so without this they tick in lockstep forever and every collision is mutual.
let auctionBackoffUntil = Date.now() + Math.floor(Math.random() * config.cow.pollJitterMs);
const auctionTimer = setInterval(() => {
  if (auctionInFlight || Date.now() < auctionBackoffUntil) return;
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
// Chains without a KalqiX book have no reference price, so seed one from Kyber
// and keep it fresh; nothing can be costed without it. Placed here rather than
// beside the other startup calls because it reads consts declared below them,
// and a top-level await above their declarations is a temporal dead zone —
// which crash-looped the process on every supervisor pass.
await refreshNativeUsd();
const nativeUsdTimer = setInterval(() => void refreshNativeUsd(), 180_000);

let quoteCursor = 0;
const quoteTimer = setInterval(() => {
  // Rotate the starting point each round. Iterating insertion order meant the
  // oldest tracked orders always reached Kyber first and the newest never did.
  const all = [...tracked.values()];
  quoteCursor = all.length === 0 ? 0 : (quoteCursor + 1) % all.length;
  const ordered = all.slice(quoteCursor).concat(all.slice(0, quoteCursor));
  for (const t of ordered) {
    void quoteRound(t).catch((err) => logError(`quote round ${t.order.uid.slice(0, 12)}`, err));
  }
}, config.cow.solverQuoteIntervalMs);

const status = setInterval(() => {
  log(
    `status: tracked=${tracked.size} discovered=${discovered} bids=${bidsPlaced} ` +
      `resolved=${resolvedCount} won=${wonCount} holdChecks=${holdChecks} evicted=${evicted} ` +
      `new=${rejected.newUids} rejected(lookup=${rejected.lookup} notOpen=${rejected.notOpen} ` +
      `expired=${rejected.expired} noDecimals=${rejected.noDecimals} noQuote=${rejected.noQuote} tooFar=${rejected.tooFar} gaveUp=${rejected.giveUp}) ` +
      `kyberBudget=${kyberBudget.available}/${config.kyber.budgetPerWindow} (denied ${kyberBudget.denied}) ` +
      `pollSlotSkips=${slotDenied} ` +
      `bebop=${bebop.enabled ? `${bebop.state}/${bebop.books.size}pairs` : 'off'} ` +
      (db.storagePressure ? ` STORAGE-PRESSURE(${db.droppedTicks} dropped)` : '')
  );
}, 60_000);

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log('SIGINT: shutting down...');
  clearInterval(nativeUsdTimer);
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

log(`${config.chainLabel} solver running (Ctrl+C to stop)`);
