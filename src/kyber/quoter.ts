import { config } from '../../config.js';
import { fetchKyberQuote, KyberRateLimitError, type KyberQuote } from './client.js';
import { logError } from '../log.js';

interface Tracked {
  tokenIn: string;
  tokenOut: string;
  /** current remaining maker amount, read fresh at each quote */
  amount: () => bigint;
  inFlight: boolean;
  kyberOnly: boolean;
}

/** Per-order Kyber quote loops. Unlike the KalqiX book (one shared sampler per
 *  pair), aggregator quotes are size-specific, so each live order polls its own
 *  quote at its current remaining size. */
export class KyberQuoter {
  readonly latest = new Map<string, KyberQuote>();
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private pausedUntilMs = 0;
  private stopped = false;
  quoteCount = 0;

  constructor(private readonly onRateLimit?: () => void) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pollAll(), config.kyber.quoteIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** KalqiX-pair orders always get a slot (they are the core experiment);
   *  kyber-only orders take spare capacity up to their own sub-cap.
   *  Returns whether the order is now tracked. */
  track(orderHash: string, tokenIn: string, tokenOut: string, amount: () => bigint, kyberOnly = false): boolean {
    if (kyberOnly && !this.tracked.has(orderHash)) {
      const kyberOnlyCount = [...this.tracked.values()].filter((t) => t.kyberOnly).length;
      if (kyberOnlyCount >= config.kyber.maxKyberOnlyTracked || this.tracked.size >= config.kyber.maxTrackedOrders) {
        return false;
      }
    }
    this.tracked.set(orderHash, { tokenIn, tokenOut, amount, inFlight: false, kyberOnly });
    void this.poll(orderHash); // first quote immediately
    return true;
  }

  untrack(orderHash: string): void {
    this.tracked.delete(orderHash);
    this.latest.delete(orderHash);
  }

  get trackedCount(): number {
    return this.tracked.size;
  }

  private pollAll(): void {
    if (this.stopped || Date.now() < this.pausedUntilMs) return;
    for (const hash of this.tracked.keys()) void this.poll(hash);
  }

  private async poll(orderHash: string): Promise<void> {
    const t = this.tracked.get(orderHash);
    if (!t || t.inFlight || this.stopped || Date.now() < this.pausedUntilMs) return;
    const amount = t.amount();
    if (amount <= 0n) return;
    t.inFlight = true;
    try {
      const quote = await fetchKyberQuote(t.tokenIn, t.tokenOut, amount);
      if (!this.stopped && this.tracked.has(orderHash)) {
        this.latest.set(orderHash, quote);
        this.quoteCount++;
      }
    } catch (err) {
      if (err instanceof KyberRateLimitError) {
        this.pausedUntilMs = Date.now() + 10_000;
        this.onRateLimit?.();
      } else {
        logError(`kyber quote failed for ${orderHash}`, err);
      }
    } finally {
      t.inFlight = false;
    }
  }
}
