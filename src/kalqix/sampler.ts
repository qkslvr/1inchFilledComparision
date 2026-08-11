import { gunzipSync, gzipSync } from 'node:zlib';
import { config, NATIVE_SENTINEL } from '../../config.js';
import { pancakeSpot } from '../pancake/quoter.js';
import { rescale } from '../pricing/units.js';
import type { PairConfig, ParsedBook, SnapshotRecord } from '../types.js';
import type { Db } from '../db/db.js';
import { fetchOrderBook, KalqixRateLimitError, type BookFetcher } from './client.js';
import { bestAsk, bestBid, depthBase, mid } from './book.js';
import { logError } from '../log.js';

export function serializeBook(book: ParsedBook): Buffer {
  const compact = {
    bids: book.bids.map((l) => [l.price.toString(), l.qty.toString()]),
    asks: book.asks.map((l) => [l.price.toString(), l.qty.toString()]),
  };
  return gzipSync(JSON.stringify(compact), { level: 1 });
}

export function deserializeBook(gz: Buffer): ParsedBook {
  const compact = JSON.parse(gunzipSync(gz).toString()) as { bids: [string, string][]; asks: [string, string][] };
  return {
    bids: compact.bids.map(([p, q]) => ({ price: BigInt(p), qty: BigInt(q) })),
    asks: compact.asks.map(([p, q]) => ({ price: BigInt(p), qty: BigInt(q) })),
  };
}

/** One 1 Hz book sampler per ticker, active only while live orders exist on the
 *  pair. Persists every snapshot; keeps the latest in memory for pricing ticks. */
/** Restate a KalqiX book in a pair's own units.
 *
 *  KalqiX quotes cbBTC/USDC and ETH/USDC on Base. A pair elsewhere hedging on
 *  one of those may carry different decimals for the same economic asset —
 *  BSC's BTCB is 18dp against cbBTC's 8, its USDT 18dp against USDC's 6. Prices
 *  are quote-units per whole base, so only the quote scale moves them;
 *  quantities are base units and move with the base scale. Converting here
 *  means every walk, mid and depth figure downstream is already in the units
 *  the order is denominated in. */
export function rescaleBook(book: ParsedBook, pair: PairConfig): ParsedBook {
  const k = pair.kalqix;
  if (!k || (k.baseDecimals === pair.base.decimals && k.quoteDecimals === pair.quote.decimals)) {
    return book;
  }
  const level = (l: { price: bigint; qty: bigint }) => ({
    price: rescale(l.price, k.quoteDecimals, pair.quote.decimals),
    qty: rescale(l.qty, k.baseDecimals, pair.base.decimals),
  });
  return { bids: book.bids.map(level), asks: book.asks.map(level) };
}

export class Sampler {
  latest: SnapshotRecord | null = null;
  sampleCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private pausedUntilMs = 0;
  private lastSuccessMs = 0;
  private stopped = false;

  constructor(
    readonly pair: PairConfig,
    private readonly db: Db,
    private readonly runId: () => number,
    private readonly fetchBook: BookFetcher = fetchOrderBook
  ) {}

  get ticker(): string {
    return this.pair.ticker;
  }

  get active(): boolean {
    return this.timer !== null;
  }

  setActive(active: boolean): void {
    if (active && this.timer === null) {
      this.timer = setInterval(() => void this.sample(), config.sampleIntervalMs);
      void this.sample();
    } else if (!active && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Unlike setActive(false), also blocks any in-flight sample from touching the DB. */
  stop(): void {
    this.stopped = true;
    this.setActive(false);
  }

  private async sample(): Promise<void> {
    if (this.inFlight || this.stopped || Date.now() < this.pausedUntilMs) return;
    this.inFlight = true;
    try {
      // Fetch the KalqiX market, then restate it in this pair's units.
      const market = this.pair.kalqix?.ticker ?? this.pair.ticker;
      const raw = await this.fetchBook(market, config.bookDepth);
      if (this.stopped) return;
      const book = rescaleBook(raw.book, this.pair);
      const { receivedAtMs, fetchMs } = raw;
      // Awaited: the snapshot id goes onto every tick that cites this book, so
      // the row has to exist before pricing can reference it.
      const id = await this.db.insertSnapshot(
        this.ticker,
        receivedAtMs,
        fetchMs,
        bestBid(book),
        bestAsk(book),
        mid(book),
        depthBase(book.bids),
        depthBase(book.asks),
        serializeBook(book)
      );
      if (this.stopped) return;
      this.latest = { id, ticker: this.ticker, tsMs: receivedAtMs, book };
      this.sampleCount++;
      if (this.lastSuccessMs > 0 && receivedAtMs - this.lastSuccessMs > 2 * config.sampleIntervalMs) {
        this.db.event(this.runId(), 'sample_gap', {
          ticker: this.ticker,
          gapMs: receivedAtMs - this.lastSuccessMs,
        });
      }
      this.lastSuccessMs = receivedAtMs;
    } catch (err) {
      if (err instanceof KalqixRateLimitError) {
        this.pausedUntilMs = Date.now() + err.retryAfterMs;
        this.db.event(this.runId(), 'kalqix_429', { ticker: this.ticker, retryAfterMs: err.retryAfterMs });
      } else {
        logError(`sample ${this.ticker} failed`, err);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

/** Fetches mids for all configured tickers every refPriceIntervalMs, regardless
 *  of live orders. Needed for gas conversion and USD normalization when the
 *  pair's sampler is idle. */
export class RefPriceLoop {
  /** ticker -> latest mid (quote units per whole base). */
  readonly latestMid = new Map<string, { tsMs: number; mid: bigint }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly db: Db) {}

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll(), config.refPriceIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    for (const pair of config.pairs) {
      if (this.stopped) return;
      try {
        // Chains KalqiX doesn't quote have no book to take a mid from, so the
        // on-chain DEX prices the pair instead. Gas conversion is the only
        // consumer, and it needs a number for every chain.
        const priced = pair.kalqix
          ? await this.kalqixMid(pair)
          : await this.onchainMid(pair);
        if (priced !== null && !this.stopped) {
          this.latestMid.set(pair.ticker, priced);
          this.db.insertRefPrice(pair.ticker, priced.tsMs, priced.mid);
        }
      } catch (err) {
        logError(`ref price ${pair.ticker} failed`, err);
      }
    }
  }

  private async kalqixMid(pair: PairConfig): Promise<{ tsMs: number; mid: bigint } | null> {
    const { book, receivedAtMs } = await fetchOrderBook(pair.kalqix!.ticker, 1);
    const m = mid(rescaleBook(book, pair));
    return m === null ? null : { tsMs: receivedAtMs, mid: m };
  }

  private async onchainMid(pair: PairConfig): Promise<{ tsMs: number; mid: bigint } | null> {
    const baseAddr = pair.base.addresses.find((a) => a !== NATIVE_SENTINEL) ?? pair.base.addresses[0];
    const quoteAddr = pair.quote.addresses[0];
    if (!baseAddr || !quoteAddr) return null;
    const m = await pancakeSpot(baseAddr, quoteAddr, pair.base.decimals);
    return m === null ? null : { tsMs: Date.now(), mid: m };
  }
}
