import WebSocket from 'ws';
import { bebopApiKey, config } from '../../config.js';
import { decodePricingUpdate } from './proto.js';
import { log, logError } from '../log.js';

export interface BebopBook {
  base: string;
  quote: string;
  /** alternating [price, size, ...] human units, best-first */
  bids: number[];
  asks: number[];
  /** local receipt time (stream ts kept for skew diagnostics only) */
  tsMs: number;
  streamTsMs: number;
}

/** What a consumer needs from Bebop, independent of how the books arrive.
 *  BebopFeed holds a socket; BebopRelayFeed mirrors one held elsewhere. */
export interface BebopSource {
  readonly books: Map<string, BebopBook>;
  readonly decimals: Map<string, number>;
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'stopped';
  messageCount: number;
  staleReconnects: number;
  readonly enabled: boolean;
  start(): Promise<void>;
  stop(): void;
  bookFor(tokenA: string, tokenB: string): { book: BebopBook; aIsBase: boolean } | null;
  decimalsFor(token: string): number | null;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = config.bebop.reconnectMaxMs;

/** Bebop Price API consumer: one socket per chain, full-snapshot stream of all
 *  MM-quoted pairs (no subscription protocol). Sanctioned for continuous
 *  liquidity evaluation, unlike polling their RFQ quote endpoint. */
export class BebopFeed implements BebopSource {
  /** `${base}|${quote}` (lowercase) -> latest levels */
  readonly books = new Map<string, BebopBook>();
  /** token address -> decimals, from the venue tokenlist */
  readonly decimals = new Map<string, number>();
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'stopped' = 'idle';
  messageCount = 0;
  staleReconnects = 0;
  private ws: WebSocket | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastMessageAtMs = 0;
  private connectedAtMs = 0;

  constructor(private readonly onStateEvent?: (kind: 'bebop_connected' | 'bebop_disconnected') => void) {}

  get enabled(): boolean {
    return bebopApiKey() !== null;
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      log('bebop: BEBOP_API_KEY not set, venue disabled');
      return;
    }
    await this.loadTokenlist();
    this.connect();
    // the stream pushes all pairs continuously; prolonged silence on a
    // "connected" socket means it died without a close event
    this.watchdog = setInterval(() => {
      if (this.state !== 'connected') return;
      const lastSignal = Math.max(this.lastMessageAtMs, this.connectedAtMs);
      if (Date.now() - lastSignal > config.bebop.staleReconnectMs) {
        this.staleReconnects++;
        log(`bebop ws stale (${Math.round((Date.now() - lastSignal) / 1000)}s silent), forcing reconnect`);
        try {
          this.ws?.terminate();
        } catch {
          this.state = 'disconnected';
          this.scheduleReconnect();
        }
      }
    }, 15_000);
  }

  stop(): void {
    this.state = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
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

  private async loadTokenlist(): Promise<void> {
    try {
      const res = await fetch(`${config.bebop.restBase}/${config.bebop.chainSlug}/v3/tokenlist`, {
        headers: { Authorization: `Bearer ${bebopApiKey()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`tokenlist HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      // shape probed live: accept either an array of tokens or {tokens: {...}}
      const entries: Array<{ address?: string; decimals?: number }> = Array.isArray(body)
        ? (body as never[])
        : Object.values((body as { tokens?: Record<string, never> }).tokens ?? {});
      for (const t of entries) {
        if (t.address && typeof t.decimals === 'number') {
          this.decimals.set(t.address.toLowerCase(), t.decimals);
        }
      }
      log(`bebop tokenlist: ${this.decimals.size} tokens`);
    } catch (err) {
      logError('bebop tokenlist fetch failed (decimals fall back to pair config)', err);
    }
  }

  private connect(): void {
    this.state = 'connecting';
    const url = `${config.bebop.wsBase}/${config.bebop.chainSlug}/v3/pricing?format=protobuf`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${bebopApiKey()}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      log('bebop ws connected');
      this.state = 'connected';
      this.connectedAtMs = Date.now();
      this.backoffMs = BACKOFF_MIN_MS;
      this.onStateEvent?.('bebop_connected');
    });
    ws.on('message', (data: Buffer) => {
      try {
        const nowMs = Date.now();
        this.lastMessageAtMs = nowMs;
        for (const p of decodePricingUpdate(Buffer.isBuffer(data) ? data : Buffer.from(data as never))) {
          if (!p.base || !p.quote) continue;
          // ts units are ambiguous in the docs; normalize by magnitude
          const raw = Number(p.lastUpdateTs);
          const streamTsMs = raw > 1e11 ? raw : raw * 1000;
          this.books.set(`${p.base}|${p.quote}`, {
            base: p.base,
            quote: p.quote,
            bids: p.bids,
            asks: p.asks,
            tsMs: nowMs,
            streamTsMs,
          });
        }
        this.messageCount++;
      } catch (err) {
        logError('bebop decode failed', err);
      }
    });
    ws.on('error', (err: unknown) => logError('bebop ws error', err));
    ws.on('close', () => {
      if (this.state === 'stopped') return;
      const wasConnected = this.state === 'connected';
      this.state = 'disconnected';
      log('bebop ws closed');
      if (wasConnected) this.onStateEvent?.('bebop_disconnected');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.state === 'stopped' || this.reconnectTimer) return;
    const wait = Math.min(this.backoffMs * (0.5 + Math.random()), BACKOFF_MAX_MS);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    log(`bebop ws reconnect in ${Math.round(wait)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state !== 'stopped') this.connect();
    }, wait);
  }
}
