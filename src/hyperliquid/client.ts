/** Hyperliquid spot books, as a size-aware price source.
 *
 *  Hyperliquid is not a venue we can settle from. Its balances live on its own
 *  L1, unreachable from an Arbitrum call frame; the bridge carries USDC alone at
 *  three to seven minutes; ETH and BTC are Unit wrappers redeeming to Ethereum
 *  L1 and Bitcoin, not Arbitrum. It earns its place here only because the solver
 *  is assumed to hold inventory on both sides — the price it quotes is the cost
 *  of replacing that inventory, not of sourcing the fill.
 *
 *  Two traps this module exists to absorb:
 *
 *  - **Spot pairs are addressed by `@index`, never by symbol.** Only PURR/USDC
 *    answers to a name. Passing "ETH" to l2Book silently returns the *perp*
 *    book, which is a different instrument at a different price. The index is
 *    the universe index, not the token index, so it has to be read from
 *    spotMeta at startup.
 *  - **Twenty levels a side, hard.** The books are tight but shallow, exhausting
 *    somewhere around $200-500k. A walk past visible depth must return null, not
 *    an extrapolation, exactly as the KalqiX walker does. */
import { postJson } from '../http/json.js';
import type { BookLevel, ParsedBook } from '../types.js';

const INFO = 'https://api.hyperliquid.xyz/info';

interface RawLevel { px: string; sz: string; n: number }
interface RawBook { coin: string; time: number; levels: [RawLevel[], RawLevel[]] }
interface RawSpotMeta {
  universe: Array<{ tokens: [number, number]; name: string; index: number }>;
  tokens: Array<{ index: number; name: string }>;
}

/** A decimal string to base units, without going through a float.
 *
 *  "2440.2" at 6dp is 2440200000. Number() would be accurate enough at these
 *  magnitudes today and wrong the first time a token has 18 decimals and a
 *  price with more than fifteen significant digits behind it. */
export function parseDecimal(text: string, decimals: number): bigint {
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [whole = '0', frac = ''] = body.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const v = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  return neg ? -v : v;
}

/** pair name (e.g. "UETH/USDC") -> "@151". Fetched once; the universe is static
 *  enough that a restart is the right refresh interval. */
let spotIndex: Map<string, string> | null = null;

export async function loadSpotIndex(timeoutMs = 15_000): Promise<Map<string, string>> {
  if (spotIndex) return spotIndex;
  const meta = await postJson<RawSpotMeta>(INFO, { type: 'spotMeta' }, timeoutMs);
  const tokenName = new Map(meta.tokens.map((t) => [t.index, t.name]));
  const idx = new Map<string, string>();
  for (const u of meta.universe) {
    const name = u.tokens.map((i) => tokenName.get(i) ?? '?').join('/');
    idx.set(name, `@${u.index}`);
  }
  spotIndex = idx;
  return idx;
}

/** Books, cached per coin.
 *
 *  l2Book costs weight 2 against 1200/minute, so ~600 fetches a minute. Quoting
 *  every tracked order individually would blow through that on its own; there
 *  are only a handful of coins, so one cached book serves every order on it. */
const books = new Map<string, { book: ParsedBook; atMs: number }>();

export interface BookOptions {
  /** decimals of the Arbitrum token standing in for the base leg */
  baseDecimals: number;
  /** decimals of the Arbitrum token standing in for the quote leg */
  quoteDecimals: number;
  maxAgeMs: number;
  timeoutMs?: number;
}

/** L2 book for a spot coin, in our own units: price is quote atoms per WHOLE
 *  base, qty is base atoms — the convention `walkSellBase`/`walkBuyBase` expect.
 *
 *  Hyperliquid's own szDecimals/weiDecimals are deliberately ignored. We are not
 *  settling there; we want its price expressed in the Arbitrum tokens the order
 *  is actually denominated in, so its human-readable strings are the only part
 *  that carries over. */
export async function fetchSpotBook(coin: string, o: BookOptions): Promise<ParsedBook | null> {
  const hit = books.get(coin);
  if (hit && Date.now() - hit.atMs < o.maxAgeMs) return hit.book;

  const raw = await postJson<RawBook>(INFO, { type: 'l2Book', coin }, o.timeoutMs ?? 8_000);
  const side = (levels: RawLevel[]): BookLevel[] =>
    levels.map((l) => ({
      price: parseDecimal(l.px, o.quoteDecimals),
      qty: parseDecimal(l.sz, o.baseDecimals),
    }));
  const bids = side(raw.levels?.[0] ?? []);
  const asks = side(raw.levels?.[1] ?? []);
  if (bids.length === 0 && asks.length === 0) return null;

  const book: ParsedBook = { bids, asks };
  books.set(coin, { book, atMs: Date.now() });
  return book;
}

/** Drop cached books, so a test or a restart cannot serve a stale one. */
export function resetBooks(): void {
  books.clear();
  spotIndex = null;
}
