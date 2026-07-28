import { config } from '../../config.js';
import type { ParsedBook } from '../types.js';
import { kalqixCreds, signedGet } from './auth.js';

interface RawLevel {
  price: string;
  price_formatted?: string;
  quantity: string;
  quantity_formatted?: string;
}

interface RawBook {
  BUY: RawLevel[];
  SELL: RawLevel[];
}

export class KalqixRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`KalqiX 429, retry after ${retryAfterMs}ms`);
  }
}

export interface BookFetchResult {
  book: ParsedBook;
  receivedAtMs: number;
  fetchMs: number;
}

export type BookFetcher = (ticker: string, depth: number, timeoutMs?: number) => Promise<BookFetchResult>;

async function parseBookResponse(res: Response, ticker: string, started: number): Promise<BookFetchResult> {
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '1');
    throw new KalqixRateLimitError(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000);
  }
  if (!res.ok) {
    throw new Error(`KalqiX orderbook ${ticker}: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as RawBook;
  const receivedAtMs = Date.now();
  if (!Array.isArray(raw.BUY) || !Array.isArray(raw.SELL)) {
    throw new Error(`KalqiX orderbook ${ticker}: unexpected shape ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return {
    book: {
      bids: raw.BUY.map((l) => ({ price: BigInt(l.price), qty: BigInt(l.quantity) })),
      asks: raw.SELL.map((l) => ({ price: BigInt(l.price), qty: BigInt(l.quantity) })),
    },
    receivedAtMs,
    fetchMs: receivedAtMs - started,
  };
}

/** GET /v1/markets/{ticker}/order-book — public, no auth (the OpenAPI spec's
 *  hyphen-less /orderbook path exists but requires auth, verified live).
 *  Returns a fixed 20 levels per side regardless of the depth param.
 *  price/quantity are integer base-unit strings (quote decimals for price,
 *  base decimals for quantity). */
export const fetchOrderBook: BookFetcher = async (ticker, depth, timeoutMs = 2000) => {
  const url = `${config.kalqixApiBase}/markets/${ticker}/order-book?depth=${depth}`;
  const started = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return parseBookResponse(res, ticker, started);
};

/** Signed variant of the same /order-book path. Verified live: the hyphen-less
 *  /orderbook path in the OpenAPI spec does not exist (404 even signed), and the
 *  real endpoint returns the same fixed 20 levels with or without auth. Kept in
 *  case a later API version unlocks deeper books for authed callers. */
export const fetchOrderBookAuthed: BookFetcher = async (ticker, depth, timeoutMs = 2000) => {
  const started = Date.now();
  const res = await signedGet(`/v1/markets/${ticker}/order-book`, { depth }, timeoutMs);
  return parseBookResponse(res, ticker, started);
};

/** Prefer the public endpoint unless auth strictly returns more levels
 *  (no signing overhead, no auth failure mode mid-run). */
export async function chooseBookFetcher(
  onDecision: (msg: string) => void
): Promise<{ fetcher: BookFetcher; source: 'authed' | 'public' }> {
  const probeTicker = config.pairs[0]!.ticker;
  if (kalqixCreds()) {
    try {
      const [authed, pub] = await Promise.all([
        fetchOrderBookAuthed(probeTicker, config.bookDepth),
        fetchOrderBook(probeTicker, config.bookDepth),
      ]);
      const authedLevels = authed.book.bids.length + authed.book.asks.length;
      const publicLevels = pub.book.bids.length + pub.book.asks.length;
      if (authedLevels > publicLevels) {
        onDecision(`kalqix book source: authed (${authedLevels} levels vs public ${publicLevels})`);
        return { fetcher: fetchOrderBookAuthed, source: 'authed' };
      }
      onDecision(`kalqix book source: public (authed adds no depth: ${authedLevels} vs ${publicLevels} levels)`);
    } catch (err) {
      onDecision(`kalqix book source: public (authed probe failed: ${(err as Error).message})`);
    }
  }
  return { fetcher: fetchOrderBook, source: 'public' };
}

export interface KalqixFees {
  makerPpm: bigint;
  takerPpm: bigint;
  tier: string;
}

/** GET /v1/users/me/fees — the caller's effective fee schedule (base + partner markup). */
export async function fetchMyFees(): Promise<KalqixFees> {
  const res = await signedGet('/v1/users/me/fees', {});
  if (!res.ok) throw new Error(`KalqiX fees: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  // Live shape (verified) is flat: fees.taker_ppm; docs also describe a nested
  // fees.effective.taker_ppm variant, so accept either.
  const body = (await res.json()) as {
    base_tier?: string;
    tier_label?: string;
    fees?: {
      maker_ppm?: number;
      taker_ppm?: number;
      effective?: { maker_ppm?: number; taker_ppm?: number };
    };
  };
  const eff = body.fees?.effective ?? body.fees;
  if (!eff || typeof eff.taker_ppm !== 'number') {
    throw new Error(`KalqiX fees: unexpected shape ${JSON.stringify(body).slice(0, 200)}`);
  }
  return {
    makerPpm: BigInt(eff.maker_ppm ?? 0),
    takerPpm: BigInt(eff.taker_ppm),
    tier: body.base_tier ?? body.tier_label ?? 'unknown',
  };
}
