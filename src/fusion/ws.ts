import { NetworkEnum, WebSocketApi } from '@1inch/fusion-sdk';
import { config, oneInchApiKey } from '../../config.js';
import { log, logError } from '../log.js';

export interface OrderCreatedPayload {
  quoteId: string;
  orderHash: string;
  signature: string;
  order: {
    salt: string;
    maker: string;
    receiver: string;
    makerAsset: string;
    takerAsset: string;
    makingAmount: string;
    takingAmount: string;
    makerTraits: string;
  };
  deadline: string;
  auctionStartDate: string;
  auctionEndDate: string;
  remainingMakerAmount: string;
  extension: string;
  isMakerContract: boolean;
}

export interface FeedCallbacks {
  onOrderCreated(payload: OrderCreatedPayload, receivedAtMs: number): void;
  onOrderFilled(orderHash: string, receivedAtMs: number): void;
  onOrderFilledPartially(orderHash: string, remainingMakerAmount: string, receivedAtMs: number): void;
  onOrderCancelled(orderHash: string, receivedAtMs: number): void;
  onOrderInvalid(orderHash: string, receivedAtMs: number): void;
  onBalanceChange(orderHash: string, remainingMakerAmount: string, receivedAtMs: number): void;
  /** Fired on connect/disconnect transitions; drives the REST poll fallback. */
  onStateChange(connected: boolean): void;
}

export type FeedState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'stopped';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Fusion order-event feed with reconnect. One socket per chain; the SDK client
 *  has no reconnect of its own, so each attempt builds a fresh WebSocketApi. */
export class FusionFeed {
  private api: WebSocketApi | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private connectedAtMs = 0;
  state: FeedState = 'idle';
  lastEventAtMs = 0;
  staleReconnects = 0;

  constructor(private readonly cb: FeedCallbacks) {}

  start(): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.connect();
    // Silent TCP death delivers no close event; if a "connected" socket has
    // produced nothing for wsStaleMs, kill it so the normal reconnect + poll
    // fallback + catch-up sweep machinery takes over.
    this.watchdog = setInterval(() => {
      if (this.state !== 'connected') return;
      const lastSignal = Math.max(this.lastEventAtMs, this.connectedAtMs);
      if (Date.now() - lastSignal > config.wsStaleMs) {
        this.staleReconnects++;
        log(`ws stale (no events for ${Math.round((Date.now() - lastSignal) / 1000)}s), forcing reconnect`);
        try {
          this.api?.close(); // triggers onClose -> reconnect path
        } catch {
          this.state = 'disconnected';
          this.scheduleReconnect();
        }
      }
    }, 30_000);
  }

  stop(): void {
    this.state = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    try {
      this.api?.close();
    } catch {
      // already closed
    }
    this.api = null;
  }

  private connect(): void {
    this.state = 'connecting';
    let api: WebSocketApi;
    try {
      api = new WebSocketApi({
        url: config.oneInchWsBase,
        network: config.chainId as NetworkEnum,
        authKey: oneInchApiKey(),
      });
    } catch (err) {
      logError('ws construct failed', err);
      this.scheduleReconnect();
      return;
    }
    this.api = api;

    api.onOpen(() => {
      log('ws connected');
      this.state = 'connected';
      this.connectedAtMs = Date.now();
      this.backoffMs = BACKOFF_MIN_MS;
      this.cb.onStateChange(true);
    });

    api.order.onOrderCreated((data) => {
      this.lastEventAtMs = Date.now();
      this.cb.onOrderCreated(data.result as unknown as OrderCreatedPayload, this.lastEventAtMs);
    });
    api.order.onOrderFilled((data) => {
      this.lastEventAtMs = Date.now();
      this.cb.onOrderFilled(data.result.orderHash, this.lastEventAtMs);
    });
    api.order.onOrderFilledPartially((data) => {
      this.lastEventAtMs = Date.now();
      this.cb.onOrderFilledPartially(data.result.orderHash, data.result.remainingMakerAmount, this.lastEventAtMs);
    });
    api.order.onOrderCancelled((data) => {
      this.lastEventAtMs = Date.now();
      this.cb.onOrderCancelled(data.result.orderHash, this.lastEventAtMs);
    });
    api.order.onOrderInvalid((data) => {
      this.lastEventAtMs = Date.now();
      this.cb.onOrderInvalid(data.result.orderHash, this.lastEventAtMs);
    });
    api.order.onOrderBalanceOrAllowanceChange((data) => {
      this.lastEventAtMs = Date.now();
      this.cb.onBalanceChange(data.result.orderHash, data.result.remainingMakerAmount, this.lastEventAtMs);
    });

    api.onError((err: unknown) => {
      logError('ws error', err);
    });
    api.onClose(() => {
      if (this.state === 'stopped') return;
      const wasConnected = this.state === 'connected';
      this.state = 'disconnected';
      log('ws closed');
      if (wasConnected) this.cb.onStateChange(false);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.state === 'stopped' || this.reconnectTimer) return;
    const jitter = 0.5 + Math.random();
    const wait = Math.min(this.backoffMs * jitter, BACKOFF_MAX_MS);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    log(`ws reconnect in ${Math.round(wait)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state !== 'stopped') this.connect();
    }, wait);
  }
}
