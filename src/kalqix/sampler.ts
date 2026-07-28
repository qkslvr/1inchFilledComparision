import { gunzipSync, gzipSync } from 'node:zlib';
import { config } from '../../config.js';
import type { ParsedBook, SnapshotRecord } from '../types.js';
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
export class Sampler {
  latest: SnapshotRecord | null = null;
  sampleCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private pausedUntilMs = 0;
  private lastSuccessMs = 0;
  private stopped = false;

  constructor(
    readonly ticker: string,
    private readonly db: Db,
    private readonly runId: () => number,
    private readonly fetchBook: BookFetcher = fetchOrderBook
  ) {}

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
      const { book, receivedAtMs, fetchMs } = await this.fetchBook(this.ticker, config.bookDepth);
      if (this.stopped) return;
      const id = this.db.insertSnapshot(
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
        const { book, receivedAtMs } = await fetchOrderBook(pair.ticker, 1);
        const m = mid(book);
        if (m !== null && !this.stopped) {
          this.latestMid.set(pair.ticker, { tsMs: receivedAtMs, mid: m });
          this.db.insertRefPrice(pair.ticker, receivedAtMs, m);
        }
      } catch (err) {
        logError(`ref price ${pair.ticker} failed`, err);
      }
    }
  }
}
