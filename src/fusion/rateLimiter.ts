/** Token bucket with FIFO queue. All 1inch REST traffic goes through one instance
 *  so the Dev Portal ~1 rps budget is respected no matter who calls. */
export class RateLimiter {
  private tokens: number;
  private lastRefillMs = Date.now();
  private penaltyUntilMs = 0;
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number
  ) {
    this.tokens = burst;
  }

  /** Queue `fn`; it runs when a token is available. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        fn().then(resolve, reject);
      });
      this.pump();
    });
  }

  /** Pause dispensing (e.g. after a 429). */
  penalize(ms: number): void {
    this.penaltyUntilMs = Math.max(this.penaltyUntilMs, Date.now() + ms);
    this.pump();
  }

  get pending(): number {
    return this.queue.length;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefillMs) / 1000) * this.ratePerSec);
    this.lastRefillMs = now;
  }

  private pump(): void {
    this.refill();
    const now = Date.now();
    while (this.queue.length > 0 && this.tokens >= 1 && now >= this.penaltyUntilMs) {
      this.tokens -= 1;
      const job = this.queue.shift()!;
      job();
    }
    if (this.queue.length > 0 && this.timer === null) {
      const waitForToken = ((1 - this.tokens) / this.ratePerSec) * 1000;
      const waitForPenalty = this.penaltyUntilMs - now;
      const wait = Math.max(waitForToken, waitForPenalty, 10);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
    }
  }
}
