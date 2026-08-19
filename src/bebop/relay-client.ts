/** Reads Bebop books from the local relay instead of holding a socket.
 *
 *  Deliberately exposes the same surface as BebopFeed, so a caller cannot tell
 *  which one it has — see BebopSource. The relay owns the single connection the
 *  API key allows; this just mirrors its books. */
import { config } from '../../config.js';
import type { BebopBook, BebopSource } from './feed.js';
import type { RelayPayload } from './relay-protocol.js';
import { log, logError } from '../log.js';


export class BebopRelayFeed implements BebopSource {
  readonly books = new Map<string, BebopBook>();
  readonly decimals = new Map<string, number>();
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'stopped' = 'idle';
  messageCount = 0;
  staleReconnects = 0;
  /** Optimistic until the relay says otherwise: a relay that has not answered
   *  yet is not the same as a venue we are not configured for. */
  private relayEnabled = true;
  private sinceMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private wasConnected = false;
  private lastErrorLogMs = 0;

  constructor(private readonly onStateEvent?: (kind: 'bebop_connected' | 'bebop_disconnected') => void) {}

  get enabled(): boolean {
    return this.relayEnabled;
  }

  async start(): Promise<void> {
    this.state = 'connecting';
    log(`bebop: reading from relay at 127.0.0.1:${config.bebop.relayPort}`);
    await this.poll();
    this.timer = setInterval(() => void this.poll(), config.bebop.relayPollMs);
  }

  stop(): void {
    this.state = 'stopped';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Latest book covering (tokenA, tokenB) in either orientation. */
  bookFor(tokenA: string, tokenB: string): { book: BebopBook; aIsBase: boolean } | null {
    const a = tokenA.toLowerCase();
    const b = tokenB.toLowerCase();
    const direct = this.books.get(`${a}|${b}`);
    if (direct) return { book: direct, aIsBase: true };
    const inverse = this.books.get(`${b}|${a}`);
    if (inverse) return { book: inverse, aIsBase: false };
    return null;
  }

  decimalsFor(token: string): number | null {
    return this.decimals.get(token.toLowerCase()) ?? null;
  }

  private async poll(): Promise<void> {
    if (this.inFlight || this.state === 'stopped') return;
    this.inFlight = true;
    try {
      const res = await fetch(
        `http://127.0.0.1:${config.bebop.relayPort}/books?since=${this.sinceMs}`,
        { signal: AbortSignal.timeout(config.bebop.relayTimeoutMs) }
      );
      if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
      const body = (await res.json()) as RelayPayload;

      this.relayEnabled = body.enabled;
      this.messageCount = body.messageCount;
      this.staleReconnects = body.staleReconnects;
      // Our own health is the relay's health: if its socket is down, our books
      // are stale no matter how well the loopback hop is working.
      this.state = body.state === 'connected' ? 'connected' : 'disconnected';
      if (body.decimals) for (const [addr, dec] of body.decimals) this.decimals.set(addr, dec);
      // Books are merged, never replaced. The relay only sends what moved, and a
      // pair that stops quoting keeps its last book here exactly as it would on
      // a live socket — staleness is judged from book.tsMs downstream.
      for (const [key, book] of body.books) this.books.set(key, book);
      if (body.maxTsMs > this.sinceMs) this.sinceMs = body.maxTsMs;

      if (this.state === 'connected' && !this.wasConnected) {
        this.wasConnected = true;
        this.onStateEvent?.('bebop_connected');
      } else if (this.state !== 'connected' && this.wasConnected) {
        this.wasConnected = false;
        this.onStateEvent?.('bebop_disconnected');
      }
    } catch (err) {
      // Log the first failure and then at most once a minute. Logging only on
      // the transition meant a relay that was never reachable said so exactly
      // once, at startup, and then went quiet for hours.
      const now = Date.now();
      if (now - this.lastErrorLogMs > 60_000) {
        this.lastErrorLogMs = now;
        logError(`bebop relay poll failed (127.0.0.1:${config.bebop.relayPort})`, err);
      }
      this.state = 'disconnected';
      if (this.wasConnected) {
        this.wasConnected = false;
        this.onStateEvent?.('bebop_disconnected');
      }
    } finally {
      this.inFlight = false;
    }
  }
}
