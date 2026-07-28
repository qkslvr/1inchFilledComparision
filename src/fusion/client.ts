import {
  FusionSDK,
  NetworkEnum,
  type LimitOrderV4Struct,
  type OrderStatusResponse,
} from '@1inch/fusion-sdk';

/** Not re-exported from the SDK root; mirrors src/api/orders/types.ts. */
export interface ActiveOrder {
  quoteId: string;
  orderHash: string;
  signature: string;
  deadline: string;
  auctionStartDate: string;
  auctionEndDate: string;
  remainingMakerAmount: string;
  order: LimitOrderV4Struct;
  extension: string;
  version: string;
}

export interface ActiveOrdersResponse {
  items: ActiveOrder[];
  meta: { totalItems: number; itemsPerPage: number; totalPages: number; currentPage: number };
}
import { config, oneInchApiKey } from '../../config.js';
import { RateLimiter } from './rateLimiter.js';
import { log } from '../log.js';

class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string
  ) {
    super(`1inch HTTP ${status} for ${url}`);
  }
}

/** fetch-based HttpProviderConnector: Bearer auth, token-bucket routing,
 *  Date-header capture for clock skew, one retry cycle on 429. */
class FetchProvider {
  lastServerDateMs: number | null = null;
  lastSkewMs: number | null = null;

  constructor(
    private readonly authKey: string,
    private readonly limiter: RateLimiter
  ) {}

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.limiter.schedule(() =>
        fetch(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${this.authKey}` },
          signal: AbortSignal.timeout(10_000),
        })
      );
      const dateHeader = res.headers.get('date');
      if (dateHeader) {
        const serverMs = Date.parse(dateHeader);
        if (Number.isFinite(serverMs)) {
          this.lastServerDateMs = serverMs;
          // Date header has 1s granularity; skew is approximate by design.
          this.lastSkewMs = serverMs - Date.now();
        }
      }
      if (res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '2');
        const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 2) * 1000;
        log(`1inch 429, backing off ${waitMs}ms (attempt ${attempt + 1})`);
        this.limiter.penalize(waitMs);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url);
      return (await res.json()) as T;
    }
  }

  get<T>(url: string): Promise<T> {
    return this.request<T>(url, { method: 'GET' });
  }

  post<T>(url: string, data: unknown): Promise<T> {
    return this.request<T>(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export class FusionClient {
  readonly limiter: RateLimiter;
  private readonly provider: FetchProvider;
  private readonly sdk: FusionSDK;
  on429?: () => void;

  constructor() {
    this.limiter = new RateLimiter(config.restRatePerSec, config.restBurst);
    this.provider = new FetchProvider(oneInchApiKey(), this.limiter);
    this.sdk = new FusionSDK({
      url: config.oneInchApiBase,
      network: config.chainId as NetworkEnum,
      httpProvider: this.provider,
    });
  }

  /** Local minus server clock offset measured from the last REST response. */
  get skewMs(): number | null {
    return this.provider.lastSkewMs;
  }

  /** Raw fetch, deliberately NOT via sdk.getActiveOrders: the SDK hardwires a
   *  version=2.1 query filter, but live Base orders are version 2.2, so the SDK
   *  call returns an empty list (verified 2026-07). No version param = all current. */
  getActiveOrders(page: number, limit: number): Promise<ActiveOrdersResponse> {
    return this.provider.get<ActiveOrdersResponse>(
      `${config.oneInchApiBase}/orders/v2.0/${config.chainId}/order/active/?page=${page}&limit=${limit}`
    );
  }

  /** Full paginated sweep of active orders on the chain. */
  async getAllActiveOrders(maxPages = 20): Promise<ActiveOrder[]> {
    const out: ActiveOrder[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.getActiveOrders(page, 500);
      out.push(...res.items);
      if (page >= res.meta.totalPages) break;
    }
    return out;
  }

  getOrderStatus(orderHash: string): Promise<OrderStatusResponse> {
    return this.sdk.getOrderStatus(orderHash);
  }
}
