/** A spend limit for KyberSwap requests, so tracking more orders does not mean
 *  rate-limiting ourselves.
 *
 *  Kyber publishes the budget in its own response headers — `x-ratelimit-limit:
 *  30, 10`, i.e. 30 requests per 10 seconds, per IP — and every collector on
 *  this host shares that IP. Quoting N orders on a fixed interval scales request
 *  volume linearly with N, so raising the tracked count without a limiter just
 *  converts more orders into more 429s and fewer usable quotes.
 *
 *  A token bucket instead: KalqiX and Bebop are in-memory and free, so they can
 *  be walked for every order on every round, and Kyber is spent on whatever the
 *  budget allows. An order that misses out keeps its previous Kyber quote, which
 *  ages rather than vanishing. */
export class RequestBudget {
  private tokens: number;
  private lastRefillMs = Date.now();
  granted = 0;
  denied = 0;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number
  ) {
    this.tokens = capacity;
  }

  /** Take one request's worth of budget, or report that there is none. */
  take(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;
    if (elapsed > 0) {
      // Continuous refill rather than a window reset: a hard reset lets the
      // whole allowance be spent in one burst the instant it rolls over, which
      // is the shape most likely to trip the limit it is meant to respect.
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs);
      this.lastRefillMs = now;
    }
    if (this.tokens < 1) {
      this.denied++;
      return false;
    }
    this.tokens -= 1;
    this.granted++;
    return true;
  }

  get available(): number {
    return Math.floor(this.tokens);
  }
}
