import { config } from '../../config.js';
import type { Direction, PairConfig } from '../types.js';
import type { Db, TickInsert } from '../db/db.js';
import type { DecodedOrder } from '../fusion/auction.js';
import { costAt, isExclusiveAt, rateBumpAt } from '../fusion/auction.js';
import type { Sampler, RefPriceLoop } from '../kalqix/sampler.js';
import type { GasPoller } from '../gas/poller.js';
import type { KyberQuoter } from '../kyber/quoter.js';
import type { BebopFeed } from '../bebop/feed.js';
import { walkBuyBaseFloat, walkSellBaseFloat } from '../bebop/depth.js';
import { NATIVE_SENTINEL } from '../../config.js';
import { toFloat } from './units.js';
import { walkBuyBase, walkSellBase } from '../kalqix/book.js';
import {
  baseForQuoteCeil,
  baseForQuoteFloor,
  bpsOfCeil,
  mulDivCeil,
  mulDivFloor,
  ppmOfCeil,
  quoteForBaseCeil,
  quoteForBaseFloor,
} from './units.js';
import { logError } from '../log.js';

export interface LiveOrder {
  orderHash: string;
  decoded: DecodedOrder;
  /** null for kyber-only orders (no KalqiX market) */
  pair: PairConfig | null;
  direction: Direction | null;
  /** actual token addresses from the order, used for Kyber quotes */
  makerAsset: string;
  takerAsset: string;
  remainingMaker: bigint;
  allowPartialFills: boolean;
  deadlineMs: number;
  /** KalqiX-unsupported order priced via Kyber only */
  kyberOnly: boolean;
  /** collector-side cache so setShadow fires once (report recomputes anyway) */
  tShadowRecorded: boolean;
  maxEdge: bigint | null;
  tShadowKyberRecorded: boolean;
  maxEdgeKyber: bigint | null;
  tShadowBebopRecorded: boolean;
  maxEdgeBebop: bigint | null;
}

/** human-unit float -> token base units, floored; splits large exponents so
 *  float64 precision is spent on significant digits, not trailing zeros */
function humanToUnits(x: number, decimals: number): bigint {
  if (!Number.isFinite(x) || x <= 0) return 0n;
  if (decimals <= 12) return BigInt(Math.floor(x * 10 ** decimals));
  return BigInt(Math.floor(x * 1e12)) * 10n ** BigInt(decimals - 12);
}

/** 1 Hz shadow-pricing loop over all live eligible orders. Persists one tick per
 *  order per second with edge components broken out (sensitivity recompute needs
 *  the raw parts, not the summed edge). */
export class PricingEngine {
  private readonly orders = new Map<string, LiveOrder>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  tickCount = 0;

  constructor(
    private readonly db: Db,
    private readonly samplers: Map<string, Sampler>,
    private readonly refPrices: RefPriceLoop,
    private readonly gas: GasPoller,
    private readonly skewMs: () => number,
    private readonly runId: () => number,
    /** KalqiX taker fee in ppm; config default or the account's live effective rate. */
    private readonly takerFeePpm: bigint = config.kalqixTakerFeeBps * 100n,
    private readonly kyber: KyberQuoter | null = null,
    private readonly bebop: BebopFeed | null = null
  ) {}

  get liveCount(): number {
    return this.orders.size;
  }

  liveHashes(): string[] {
    return [...this.orders.keys()];
  }

  has(orderHash: string): boolean {
    return this.orders.has(orderHash);
  }

  /** Returns false for a kyber-only order that could not get a quoter slot
   *  (it should then not be tracked at all). */
  register(order: LiveOrder): boolean {
    const amountFn = () => this.orders.get(order.orderHash)?.remainingMaker ?? 0n;
    if (order.kyberOnly) {
      const tracked =
        this.kyber?.track(order.orderHash, order.makerAsset, order.takerAsset, amountFn, true) ?? false;
      if (!tracked) return false;
      this.orders.set(order.orderHash, order);
      return true;
    }
    this.orders.set(order.orderHash, order);
    this.syncSamplers();
    this.kyber?.track(order.orderHash, order.makerAsset, order.takerAsset, amountFn);
    return true;
  }

  updateRemaining(orderHash: string, remaining: bigint): void {
    const o = this.orders.get(orderHash);
    if (o) o.remainingMaker = remaining;
  }

  unregister(orderHash: string): void {
    this.orders.delete(orderHash);
    this.syncSamplers();
    this.kyber?.untrack(orderHash);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tickAll(), config.pricingIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A pair's sampler runs iff at least one live order needs its book. */
  private syncSamplers(): void {
    const activeTickers = new Set<string>();
    for (const o of this.orders.values()) {
      if (o.pair) activeTickers.add(o.pair.ticker);
    }
    for (const [ticker, sampler] of this.samplers) {
      sampler.setActive(activeTickers.has(ticker));
    }
  }

  /** Latest mid for a ticker, from whichever source is fresher: the pair's
   *  sampler (idle samplers hold their last, aging snapshot) or the 30s ref loop. */
  private midFor(ticker: string): bigint | null {
    let snapMid: { tsMs: number; mid: bigint } | null = null;
    const snap = this.samplers.get(ticker)?.latest;
    if (snap) {
      const bb = snap.book.bids[0]?.price;
      const ba = snap.book.asks[0]?.price;
      if (bb !== undefined && ba !== undefined) snapMid = { tsMs: snap.tsMs, mid: (bb + ba) / 2n };
    }
    const ref = this.refPrices.latestMid.get(ticker) ?? null;
    const best = [snapMid, ref].filter((x) => x !== null).sort((a, b) => b!.tsMs - a!.tsMs)[0];
    return best?.mid ?? null;
  }

  /** Convert a wei amount (ETH 18dp) into takerAsset units, ceiled. */
  private weiToTakerAsset(wei: bigint, o: LiveOrder): bigint | null {
    const takerIsBase = o.direction === 'BUY_BASE';
    const takerSymbol = takerIsBase ? o.pair!.base.symbol : o.pair!.quote.symbol;
    if (takerSymbol === 'ETH') return wei;
    const ethMid = this.midFor('ETH_USDC');
    if (ethMid === null) return null;
    const usdc = quoteForBaseCeil(wei, ethMid, 18);
    if (takerSymbol === 'USDC') return usdc;
    // cbBTC taker: USDC -> cbBTC via the pair's own mid
    const btcMid = this.midFor(o.pair!.ticker);
    if (btcMid === null) return null;
    return baseForQuoteCeil(usdc, btcMid, o.pair!.base.decimals);
  }

  /** takerAsset units -> USDC (6dp) via mids, floored. Display/bucketing only. */
  private takerAssetToUsdc(amount: bigint, o: LiveOrder): bigint | null {
    const takerIsBase = o.direction === 'BUY_BASE';
    if (!takerIsBase) return amount; // taker is USDC
    const m = this.midFor(o.pair!.ticker);
    if (m === null) return null;
    return quoteForBaseFloor(amount, m, o.pair!.base.decimals);
  }

  private tickAll(): void {
    if (this.stopped) return;
    const nowMs = Date.now();
    for (const o of this.orders.values()) {
      try {
        const tick = this.priceOrder(o, nowMs);
        if (tick) {
          this.db.insertTick(tick);
          this.tickCount++;
          this.updateShadowCache(o, tick);
        }
      } catch (err) {
        logError(`tick failed for ${o.orderHash}`, err);
      }
    }
  }

  private priceOrder(o: LiveOrder, nowMs: number): TickInsert | null {
    if (o.remainingMaker <= 0n) return null;
    const nowSec = BigInt(Math.floor((nowMs + this.skewMs()) / 1000));
    const gas = this.gas.latest;
    const baseFeeWei = gas?.baseFeeWei ?? 0n;
    const gasPriceWei = gas?.gasPriceWei ?? 0n;

    const auctionCost = costAt(o.decoded, o.remainingMaker, nowSec, baseFeeWei);
    const rateBump = rateBumpAt(o.decoded, nowSec, baseFeeWei);
    const exclusive = isExclusiveAt(o.decoded, nowSec);

    if (o.kyberOnly) {
      return this.priceKyberOnly(o, nowMs, auctionCost, rateBump, exclusive, gasPriceWei, gas ? baseFeeWei : null);
    }

    const snap = this.samplers.get(o.pair!.ticker)?.latest ?? null;
    const snapshotAgeMs = snap ? nowMs - snap.tsMs : null;
    const degraded = snap === null || snapshotAgeMs! > config.degradedSnapshotAgeMs;

    // Hedge walk: we receive remainingMaker of makerAsset and sell it for takerAsset.
    let hedgeProceeds: bigint | null = null;
    let insufficientDepth = false;
    if (snap) {
      const walk =
        o.direction === 'SELL_BASE'
          ? walkSellBase(snap.book.bids, o.remainingMaker, o.pair!.base.decimals)
          : walkBuyBase(snap.book.asks, o.remainingMaker, o.pair!.base.decimals);
      hedgeProceeds = walk.proceeds;
      insufficientDepth = walk.proceeds === null;
    }

    const gasWei = config.gasUnits * gasPriceWei;
    const gasCostRaw = this.weiToTakerAsset(gasWei, o);
    const notionalTaker = auctionCost;
    const notionalUsdc = this.takerAssetToUsdc(notionalTaker, o);
    const feeCost = hedgeProceeds !== null ? ppmOfCeil(hedgeProceeds, this.takerFeePpm) : null;

    let edgeDefault: bigint | null = null;
    if (hedgeProceeds !== null && gasCostRaw !== null && feeCost !== null) {
      edgeDefault =
        hedgeProceeds -
        auctionCost -
        gasCostRaw -
        feeCost -
        bpsOfCeil(notionalTaker, config.safetyMarginBps);
    }

    // Best partial size: evaluate edge at each cumulative level boundary.
    let partialBestQty: bigint | null = null;
    let partialBestEdge: bigint | null = null;
    if (o.allowPartialFills && snap && gasCostRaw !== null) {
      const best = this.bestPartial(o, snap.book, nowSec, baseFeeWei, gasCostRaw);
      if (best) {
        partialBestQty = best.qty;
        partialBestEdge = best.edge;
      }
    }

    // Kyber venue: latest aggregator quote for this order's remaining size.
    let kyberOut: bigint | null = null;
    let kyberAmountIn: bigint | null = null;
    let kyberQuoteAgeMs: number | null = null;
    let kyberDegraded: boolean | null = null;
    let kyberGasCost: bigint | null = null;
    let kyberFee: bigint | null = null;
    let edgeKyber: bigint | null = null;
    const quote = this.kyber?.latest.get(o.orderHash);
    if (quote) {
      kyberOut = quote.amountOut;
      kyberAmountIn = quote.amountIn;
      kyberQuoteAgeMs = nowMs - quote.receivedAtMs;
      // stale quote OR quote for a different size (partial fill landed since) = degraded
      kyberDegraded =
        kyberQuoteAgeMs > config.kyber.degradedQuoteAgeMs || quote.amountIn !== o.remainingMaker;
      const swapGasWei = quote.gasUnits * gasPriceWei;
      kyberGasCost = this.weiToTakerAsset(swapGasWei, o);
      kyberFee = bpsOfCeil(kyberOut, config.kyber.feeBps);
      if (kyberGasCost !== null && gasCostRaw !== null) {
        edgeKyber =
          kyberOut -
          auctionCost -
          gasCostRaw -
          kyberGasCost -
          kyberFee -
          bpsOfCeil(notionalTaker, config.safetyMarginBps);
      }
    }

    // Bebop venue: latest streamed depth for this pair, walked at full size.
    // Native ETH orders look up the WETH book (MMs stream wrapped pairs).
    let bebopOut: bigint | null = null;
    let bebopAgeMs: number | null = null;
    let bebopDegraded: boolean | null = null;
    let bebopGasCost: bigint | null = null;
    let bebopFee: bigint | null = null;
    let edgeBebop: bigint | null = null;
    if (this.bebop && this.bebop.enabled) {
      const wethFor = (a: string) => (a.toLowerCase() === NATIVE_SENTINEL ? config.wethAddress : a);
      const found = this.bebop.bookFor(wethFor(o.makerAsset), wethFor(o.takerAsset));
      if (found) {
        const { book, aIsBase } = found;
        const makerDec =
          o.direction === 'SELL_BASE' ? o.pair!.base.decimals : o.pair!.quote.decimals;
        const takerDec =
          o.direction === 'SELL_BASE' ? o.pair!.quote.decimals : o.pair!.base.decimals;
        const makerHuman = toFloat(o.remainingMaker, makerDec);
        // maker==base: sell base into bids; maker==quote: spend quote into asks
        const outHuman = aIsBase
          ? walkSellBaseFloat(book.bids, makerHuman)
          : walkBuyBaseFloat(book.asks, makerHuman);
        bebopAgeMs = nowMs - book.tsMs;
        bebopDegraded = bebopAgeMs > config.bebop.degradedAgeMs;
        if (outHuman !== null && gasCostRaw !== null) {
          bebopOut = humanToUnits(outHuman, takerDec);
          bebopFee = bpsOfCeil(bebopOut, config.bebop.feeBps);
          const settleGas = this.weiToTakerAsset(config.bebop.gasUnits * gasPriceWei, o);
          if (settleGas !== null) {
            bebopGasCost = settleGas;
            edgeBebop =
              bebopOut -
              auctionCost -
              gasCostRaw -
              settleGas -
              bebopFee -
              bpsOfCeil(notionalTaker, config.safetyMarginBps);
          }
        }
      }
    }

    return {
      orderHash: o.orderHash,
      tsMs: nowMs,
      snapshotId: snap?.id ?? null,
      snapshotAgeMs,
      degraded,
      exclusive,
      remainingMaker: o.remainingMaker,
      rateBump,
      insufficientDepth,
      hedgeProceeds,
      auctionCost,
      gasCostRaw: gasCostRaw ?? 0n,
      baseFeeWei: gas ? baseFeeWei : null,
      gasPriceWei: gas ? gasPriceWei : null,
      feeCost,
      notionalTaker,
      notionalUsdc,
      edgeDefault,
      partialBestQty,
      partialBestEdge,
      kyberOut,
      kyberAmountIn,
      kyberQuoteAgeMs,
      kyberDegraded,
      kyberGasCost,
      kyberFee,
      edgeKyber,
      bebopOut,
      bebopAgeMs,
      bebopDegraded,
      bebopGasCost,
      bebopFee,
      edgeBebop,
    };
  }

  /** Tick for a KalqiX-unsupported order priced via Kyber alone. Without a
   *  usable quote the tick carries no information, so none is written. Gas is
   *  converted into takerAsset units through the quote's own USD valuation
   *  (float-derived, flagged in the report caveats). */
  private priceKyberOnly(
    o: LiveOrder,
    nowMs: number,
    auctionCost: bigint,
    rateBump: number,
    exclusive: boolean,
    gasPriceWei: bigint,
    baseFeeWei: bigint | null
  ): TickInsert | null {
    const quote = this.kyber?.latest.get(o.orderHash);
    if (!quote || quote.amountOutUsd6 === null || quote.amountOut <= 0n) return null;
    const ethMid = this.midFor('ETH_USDC');
    if (ethMid === null) return null;

    const weiToTakerViaQuote = (wei: bigint): bigint => {
      const usd6 = quoteForBaseCeil(wei, ethMid, 18);
      return mulDivCeil(usd6, quote.amountOut, quote.amountOutUsd6!);
    };

    const kyberQuoteAgeMs = nowMs - quote.receivedAtMs;
    const kyberDegraded =
      kyberQuoteAgeMs > config.kyber.degradedQuoteAgeMs || quote.amountIn !== o.remainingMaker;
    const fillGas = weiToTakerViaQuote(config.gasUnits * gasPriceWei);
    const swapGas = weiToTakerViaQuote(quote.gasUnits * gasPriceWei);
    const kyberFee = bpsOfCeil(quote.amountOut, config.kyber.feeBps);
    const edgeKyber =
      quote.amountOut -
      auctionCost -
      fillGas -
      swapGas -
      kyberFee -
      bpsOfCeil(auctionCost, config.safetyMarginBps);
    const notionalUsdc = mulDivFloor(auctionCost, quote.amountOutUsd6, quote.amountOut);

    // Bebop leg for long-tail pairs: works when both tokens are in Bebop's
    // tokenlist (decimals) and the pair streams; gas converts via the Kyber
    // quote's USD figures, same as the rest of this tick.
    let bebopOut: bigint | null = null;
    let bebopAgeMs: number | null = null;
    let bebopDegraded: boolean | null = null;
    let bebopGasCost: bigint | null = null;
    let bebopFee: bigint | null = null;
    let edgeBebop: bigint | null = null;
    if (this.bebop?.enabled) {
      const wethFor = (a: string) => (a.toLowerCase() === NATIVE_SENTINEL ? config.wethAddress : a);
      const makerAddr = wethFor(o.makerAsset);
      const takerAddr = wethFor(o.takerAsset);
      const found = this.bebop.bookFor(makerAddr, takerAddr);
      const makerDec = this.bebop.decimalsFor(makerAddr);
      const takerDec = this.bebop.decimalsFor(takerAddr);
      if (found && makerDec !== null && takerDec !== null) {
        const { book, aIsBase } = found;
        const makerHuman = toFloat(o.remainingMaker, makerDec);
        const outHuman = aIsBase
          ? walkSellBaseFloat(book.bids, makerHuman)
          : walkBuyBaseFloat(book.asks, makerHuman);
        bebopAgeMs = nowMs - book.tsMs;
        bebopDegraded = bebopAgeMs > config.bebop.degradedAgeMs;
        if (outHuman !== null) {
          bebopOut = humanToUnits(outHuman, takerDec);
          bebopFee = bpsOfCeil(bebopOut, config.bebop.feeBps);
          bebopGasCost = weiToTakerViaQuote(config.bebop.gasUnits * gasPriceWei);
          edgeBebop =
            bebopOut -
            auctionCost -
            fillGas -
            bebopGasCost -
            bebopFee -
            bpsOfCeil(auctionCost, config.safetyMarginBps);
        }
      }
    }

    return {
      orderHash: o.orderHash,
      tsMs: nowMs,
      snapshotId: null,
      snapshotAgeMs: null,
      degraded: true, // no KalqiX book for this order
      exclusive,
      remainingMaker: o.remainingMaker,
      rateBump,
      insufficientDepth: false,
      hedgeProceeds: null,
      auctionCost,
      gasCostRaw: fillGas,
      baseFeeWei,
      gasPriceWei: baseFeeWei !== null ? gasPriceWei : null,
      feeCost: null,
      notionalTaker: auctionCost,
      notionalUsdc,
      edgeDefault: null,
      partialBestQty: null,
      partialBestEdge: null,
      kyberOut: quote.amountOut,
      kyberAmountIn: quote.amountIn,
      kyberQuoteAgeMs,
      kyberDegraded,
      kyberGasCost: swapGas,
      kyberFee,
      edgeKyber,
      bebopOut,
      bebopAgeMs,
      bebopDegraded,
      bebopGasCost,
      bebopFee,
      edgeBebop,
    };
  }

  /** Max-edge partial fill: walk cumulative level boundaries (<= book depth
   *  evaluations), capped at remainingMaker. Returns null if no positive edge. */
  private bestPartial(
    o: LiveOrder,
    book: { bids: { price: bigint; qty: bigint }[]; asks: { price: bigint; qty: bigint }[] },
    nowSec: bigint,
    baseFeeWei: bigint,
    gasCostRaw: bigint
  ): { qty: bigint; edge: bigint } | null {
    const baseDec = o.pair!.base.decimals;
    let best: { qty: bigint; edge: bigint } | null = null;
    let cumMaker = 0n; // makerAsset consumed
    let cumProceeds = 0n; // takerAsset received

    const levels = o.direction === 'SELL_BASE' ? book.bids : book.asks;
    for (const level of levels) {
      if (o.direction === 'SELL_BASE') {
        const take = cumMaker + level.qty > o.remainingMaker ? o.remainingMaker - cumMaker : level.qty;
        if (take <= 0n) break;
        cumMaker += take;
        cumProceeds += quoteForBaseFloor(take, level.price, baseDec);
      } else {
        const levelCost = quoteForBaseCeil(level.qty, level.price, baseDec);
        const spend = cumMaker + levelCost > o.remainingMaker ? o.remainingMaker - cumMaker : levelCost;
        if (spend <= 0n) break;
        cumMaker += spend;
        cumProceeds += spend === levelCost ? level.qty : baseForQuoteFloor(spend, level.price, baseDec);
      }
      const cost = costAt(o.decoded, cumMaker, nowSec, baseFeeWei);
      const fee = ppmOfCeil(cumProceeds, this.takerFeePpm);
      const edge = cumProceeds - cost - gasCostRaw - fee - bpsOfCeil(cost, config.safetyMarginBps);
      if (edge > 0n && (best === null || edge > best.edge)) {
        best = { qty: cumMaker, edge };
      }
      if (cumMaker >= o.remainingMaker) break;
    }
    return best;
  }

  private updateShadowCache(o: LiveOrder, tick: TickInsert): void {
    if (tick.edgeDefault !== null) {
      if (tick.edgeDefault > 0n && !tick.exclusive && !o.tShadowRecorded) {
        o.tShadowRecorded = true;
        this.db.setShadow(o.orderHash, tick.tsMs, tick.snapshotId, tick.edgeDefault, tick.degraded);
      }
      if (o.maxEdge === null || tick.edgeDefault > o.maxEdge) {
        o.maxEdge = tick.edgeDefault;
        this.db.setMaxEdge(o.orderHash, tick.edgeDefault, tick.tsMs);
      }
    }
    if (tick.edgeKyber !== null) {
      if (tick.edgeKyber > 0n && !tick.exclusive && !o.tShadowKyberRecorded) {
        o.tShadowKyberRecorded = true;
        this.db.setShadowKyber(o.orderHash, tick.tsMs, tick.edgeKyber);
      }
      if (o.maxEdgeKyber === null || tick.edgeKyber > o.maxEdgeKyber) {
        o.maxEdgeKyber = tick.edgeKyber;
        this.db.setMaxEdgeKyber(o.orderHash, tick.edgeKyber);
      }
    }
    if (tick.edgeBebop !== null) {
      if (tick.edgeBebop > 0n && !tick.exclusive && !o.tShadowBebopRecorded) {
        o.tShadowBebopRecorded = true;
        this.db.setShadowBebop(o.orderHash, tick.tsMs, tick.edgeBebop);
      }
      if (o.maxEdgeBebop === null || tick.edgeBebop > o.maxEdgeBebop) {
        o.maxEdgeBebop = tick.edgeBebop;
        this.db.setMaxEdgeBebop(o.orderHash, tick.edgeBebop);
      }
    }
  }
}
