/** Per-order CoW Swap quote loops.
 *
 *  Same shape as KyberQuoter: aggregator-style quotes are size-specific, so each
 *  live order polls its own at its current remaining size.
 *
 *  Unlike Kyber there is no shared API-key budget to protect — CoW needs no key
 *  and showed no rate limiting — so there is no cap on tracked orders here. The
 *  429 path still exists because an unmetered endpoint today is not a promise
 *  about tomorrow. */
import { config } from '../../config.js';
import { fetchCowQuote, CowRateLimitError, type CowQuote } from './client.js';
import { logError } from '../log.js';

interface Tracked {
  tokenIn: string;
  tokenOut: string;
  amount: () => bigint;
  inFlight: boolean;
  /** consecutive failures; a pair CoW cannot route is not worth retrying forever */
  failures: number;
}

const MAX_FAILURES = 5;

export class CowQuoter {
  readonly latest = new Map<string, CowQuote>();
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private pausedUntilMs = 0;
  private stopped = false;
  quoteCount = 0;

  constructor(private readonly onRateLimit?: () => void) {}

  get enabled(): boolean {
    return config.cow.chainSlug !== null;
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => this.pollAll(), config.cow.quoteIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  track(orderHash: string, tokenIn: string, tokenOut: string, amount: () => bigint): void {
    if (!this.enabled) return;
    this.tracked.set(orderHash, { tokenIn, tokenOut, amount, inFlight: false, failures: 0 });
    void this.poll(orderHash);
  }

  untrack(orderHash: string): void {
    this.tracked.delete(orderHash);
    this.latest.delete(orderHash);
  }

  private pollAll(): void {
    if (this.stopped || Date.now() < this.pausedUntilMs) return;
    for (const hash of this.tracked.keys()) void this.poll(hash);
  }

  private async poll(orderHash: string): Promise<void> {
    const t = this.tracked.get(orderHash);
    if (!t || t.inFlight || this.stopped || Date.now() < this.pausedUntilMs) return;
    if (t.failures >= MAX_FAILURES) return;
    const amount = t.amount();
    if (amount <= 0n) return;
    t.inFlight = true;
    try {
      const quote = await fetchCowQuote(t.tokenIn, t.tokenOut, amount);
      if (!this.stopped && this.tracked.has(orderHash)) {
        this.latest.set(orderHash, quote);
        this.quoteCount++;
        t.failures = 0;
      }
    } catch (err) {
      if (err instanceof CowRateLimitError) {
        this.pausedUntilMs = Date.now() + 10_000;
        this.onRateLimit?.();
      } else {
        t.failures++;
        // Long-tail pairs CoW cannot route fail identically every time; after a
        // few attempts stop asking rather than filling the log once a second.
        if (t.failures <= 2) logError(`cow quote failed for ${orderHash}`, err);
      }
    } finally {
      t.inFlight = false;
    }
  }
}
